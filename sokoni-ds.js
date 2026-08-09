/* ══════════════════════════════════════════════════════════════
   SOKONI DESIGN SYSTEM JS v1.0 — window.SK
   Unified API that either delegates to SokoniUI (already injected)
   or provides the missing pieces SokoniUI does not cover.

   Delegates (no re-implementation):
     SK.toast()          → SokoniUI.toast()
     SK.dialog.open()    → SokoniUI.openModal()
     SK.dialog.confirm() → SokoniUI.confirm()
     SK.dialog.close()   → SokoniUI.closeModal()
     SK.loading.page()   → SokoniUI.showPageLoader()
     SK.loading.pageDone()→ SokoniUI.hidePageLoader()
     SK.skeleton.cards() → SokoniUI.showSkeletons()
     SK.skeleton.list()  → SokoniUI.showSkeletons()
     SK.empty()          → SokoniUI.renderEmpty/renderError

   Adds (genuinely absent from SokoniUI):
     SK.loading.btn / btnDone  — button loading state
     SK.alert()                — inline alert injection
     SK.form.validate()        — form validation
     SK.form.fieldError/Clear()— field-level feedback
     SK.search.init()          — search bar wiring + debounce
     SK.tabs.init()            — tab system wiring
     SK.dropdown.init()        — dropdown wiring
     SK.badge()                — badge HTML factory
     SK.esc() / SK.uid()       — utilities

   Loaded after SokoniUI (defer). Guards against double-init.
   ══════════════════════════════════════════════════════════════ */
(function (g) {
  'use strict';

  if (g.SK && g.SK._v) { return; }   /* already initialised */

  /* ── UTILITIES ──────────────────────────────────────────── */

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _uid(prefix) {
    return (prefix || 'sk') + (Math.random() * 1e9 | 0).toString(36);
  }

  function _debounce(fn, ms) {
    var t;
    return function () {
      var a = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, a); }, ms);
    };
  }

  function _el(id) { return document.getElementById(id); }
  function _ce(tag, cls, html) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    return el;
  }

  /* Wait for SokoniUI to be available (it is defer-loaded) */
  function _ui() { return g.SokoniUI || null; }

  /* ── TOAST ──────────────────────────────────────────────── */
  /* Delegates to SokoniUI.toast(); maps type names */

  var TYPE_MAP = { danger: 'error', warn: 'warning', success: 'success', info: 'info', error: 'error' };

  function toast(msg, type, duration) {
    var ui = _ui();
    if (ui) {
      return ui.toast(msg, TYPE_MAP[type] || type || 'info', { duration: duration });
    }
    /* Fallback if SokoniUI not yet loaded — rare */
    if (g.showNotif) g.showNotif(msg, type);
  }

  /* ── DIALOG ─────────────────────────────────────────────── */
  /* Delegates to SokoniUI.openModal / closeModal / confirm    */

  function _dialogOpen(cfg) {
    var ui = _ui();
    if (!ui) { console.warn('SK.dialog: SokoniUI not ready'); return; }
    var content = cfg.body || cfg.content || '';
    if (typeof content !== 'string') {
      var wrap = _ce('div'); wrap.appendChild(content);
      content = wrap.innerHTML;
    }
    var html = '';
    if (cfg.title) html += '<h2 class="sk-h4" style="margin-bottom:12px">' + _esc(cfg.title) + '</h2>';
    html += content;
    if (cfg.actions && cfg.actions.length) {
      html += '<div class="sk-flex sk-gap-3" style="justify-content:flex-end;margin-top:20px">';
      cfg.actions.forEach(function (a) {
        html += '<button type="button" class="sk-btn sk-btn-' + (a.type || 'ghost') + '" ' +
                'onclick="(' + (a.onClick ? a.onClick.toString() : 'function(){}') + ')()">' +
                _esc(a.label) + '</button>';
      });
      html += '</div>';
    }
    return ui.openModal({ rawHtml: html, closeable: cfg.dismissible !== false, onClose: cfg.onClose });
  }

  /* ── DIALOG TELEMETRY ───────────────────────────────────── */
  /* One shared implementation → free instrumentation. Lightweight
     counters + a `sk:dialog` CustomEvent; nothing is persisted. */
  function _dlgModule() {
    try {
      var p = (location.pathname || '').split('/').pop() || 'index';
      return p.replace(/\.html?$/i, '') || 'index';
    } catch (_) { return 'unknown'; }
  }
  function _dlgEvent(type, result, openedAt) {
    try {
      var M = (window._skDialogMetrics = window._skDialogMetrics || { total: 0, byType: {}, byResult: {} });
      M.total++;
      M.byType[type]     = (M.byType[type]     || 0) + 1;
      M.byResult[result] = (M.byResult[result] || 0) + 1;
      window.dispatchEvent(new CustomEvent('sk:dialog', { detail: {
        type: type, module: _dlgModule(), result: result,
        durationMs: openedAt ? (Date.now() - openedAt) : null, at: Date.now()
      } }));
    } catch (_) {}
  }

  function _dialogConfirm(msg, onConfirm, onCancel, opts) {
    var ui = _ui();
    opts = opts || {};
    var t0 = Date.now();
    if (ui && ui.confirm) {
      return ui.confirm({
        title:       opts.title || 'Confirm',
        message:     msg,
        confirmText: opts.confirmLabel || 'Confirm',
        cancelText:  opts.cancelLabel || 'Cancel',
        variant:     opts.variant || 'neutral',
      }).then(function (ok) {
        _dlgEvent('confirm', ok ? 'confirmed' : 'cancelled', t0);
        if (ok) { if (onConfirm) onConfirm(); }
        else    { if (onCancel) onCancel(); }
        return ok;
      });
    }
    /* Fallback */
    var ok = window.confirm(msg);
    _dlgEvent('confirm', ok ? 'confirmed' : 'cancelled', t0);
    if (ok) { if (onConfirm) onConfirm(); }
    else    { if (onCancel) onCancel(); }
    return Promise.resolve(ok);
  }

  /* Canonical replacement for native alert() — styled, focus-trapped,
     Esc/Enter-dismissable, ARIA dialog. Returns a Promise that resolves
     when dismissed. Signature stays alert-simple: _dialogAlert(msg, opts?). */
  function _dialogAlert(msg, opts) {
    opts = opts || {};
    var ui = _ui();
    var t0 = Date.now();
    if (ui && ui.openModal) {
      return new Promise(function (resolve) {
        var okLabel = opts.okLabel || opts.confirmLabel || 'OK';
        var variant = opts.variant || 'neutral';
        var btnColor = variant === 'danger'  ? 'linear-gradient(135deg,#c01,#900)' :
                       variant === 'success' ? 'linear-gradient(135deg,#71ff00,#4fc800)' :
                       'rgba(255,255,255,0.12)';
        var btnText  = variant === 'success' ? '#050f05' : '#fff';
        var content =
          '<p class="sk-modal-body" style="margin:0 0 24px">' + _esc(msg == null ? '' : String(msg)) + '</p>' +
          '<div class="sk-modal-footer" style="justify-content:flex-end">' +
            '<button id="sk-alert-ok" style="min-width:120px;padding:13px;background:' + btnColor +
            ';border:none;border-radius:12px;color:' + btnText + ';font-weight:900;font-size:14px;cursor:pointer;">' +
            _esc(okLabel) + '</button>' +
          '</div>';
        var done = false;
        var close = ui.openModal({
          title: opts.title || 'Notice', content: content, closeable: true,
          onClose: function () {
            if (done) return; done = true;
            _dlgEvent('alert', 'dismissed', t0);
            if (opts.onClose) try { opts.onClose(); } catch (_) {}
            resolve();
          }
        });
        var ok = document.getElementById('sk-alert-ok');
        if (ok) ok.addEventListener('click', function () { close(); });
      });
    }
    /* Fallback */
    window.alert(msg);
    _dlgEvent('alert', 'dismissed', t0);
    return Promise.resolve();
  }

  function _dialogClose() {
    var ui = _ui();
    if (ui) ui.closeModal();
  }

  /* ── LOADING ────────────────────────────────────────────── */

  /* Button loading state — NOT in SokoniUI */
  function _loadingBtn(btn) {
    if (!btn) return;
    btn._skOrigText    = btn.innerHTML;
    btn._skOrigDisabled = btn.disabled;
    btn.classList.add('sk-btn-loading');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
  }
  function _loadingBtnDone(btn) {
    if (!btn) return;
    btn.classList.remove('sk-btn-loading');
    btn.disabled = btn._skOrigDisabled || false;
    btn.removeAttribute('aria-busy');
    if (btn._skOrigText != null) btn.innerHTML = btn._skOrigText;
  }

  function _loadingPage(label) {
    var ui = _ui();
    if (ui) return ui.showPageLoader(label);
  }
  function _loadingPageDone() {
    var ui = _ui();
    if (ui) return ui.hidePageLoader();
  }

  /* ── SKELETON ────────────────────────────────────────────── */

  function _skelCards(container, count) {
    var ui = _ui();
    if (ui) return ui.showSkeletons(container, count || 3, 'card');
    if (container) container.innerHTML = '<div class="sk-skeleton" style="height:120px;border-radius:12px"></div>'.repeat(count || 3);
  }
  function _skelList(container, rows) {
    var ui = _ui();
    if (ui) return ui.showSkeletons(container, rows || 5, 'list');
    if (container) container.innerHTML = '<div class="sk-skeleton-text" style="margin:10px 0"></div>'.repeat(rows || 5);
  }
  function _skelClear(container) {
    if (container) container.innerHTML = '';
  }

  /* ── EMPTY / ERROR STATES ───────────────────────────────── */

  function _empty(container, cfg) {
    var ui = _ui();
    cfg = cfg || {};
    if (ui) {
      if (cfg.error) return ui.renderError(container, cfg.error || cfg.desc, cfg.onRetry);
      if (cfg.offline) return ui.renderOffline(container, cfg.onRetry);
      return ui.renderState(container, {
        icon:    cfg.icon  || '📭',
        title:   cfg.title || 'Nothing here yet',
        message: cfg.desc  || '',
        btn:     cfg.action ? { text: cfg.action, onClick: cfg.onAction } : null,
      });
    }
    /* Fallback */
    if (!container) return;
    container.innerHTML =
      '<div class="sk-empty">' +
        (cfg.icon  ? '<div class="sk-empty-icon">' + _esc(cfg.icon) + '</div>' : '') +
        (cfg.title ? '<div class="sk-empty-title">' + _esc(cfg.title) + '</div>' : '') +
        (cfg.desc  ? '<div class="sk-empty-sub">' + _esc(cfg.desc) + '</div>' : '') +
      '</div>';
  }

  /* ── STATUS CHIP — maps a status string to one of the 6 semantic colours ─ */
  var _STATUS_MAP = {
    completed:'completed', done:'completed', paid:'completed', delivered:'completed', settled:'completed', active:'completed', approved:'completed', online:'completed',
    progress:'progress', in_progress:'progress', preparing:'progress', in_transit:'progress', processing:'progress', shipped:'progress', rider_assigned:'progress', out_for_delivery:'progress',
    waiting:'waiting', pending:'waiting', awaiting:'waiting', awaiting_confirmation:'waiting', ready:'waiting', reserved:'waiting',
    premium:'premium', vip:'premium', pro:'premium', boosted:'premium', verified:'premium',
    cancelled:'cancelled', canceled:'cancelled', failed:'cancelled', refunded:'cancelled', error:'cancelled', rejected:'cancelled', disputed:'cancelled',
    inactive:'inactive', offline:'inactive', draft:'inactive', suspended:'inactive', archived:'inactive',
  };
  function _statusChip(status, label) {
    var key = String(status == null ? 'inactive' : status).toLowerCase().replace(/\s+/g, '_');
    var variant = _STATUS_MAP[key] || 'inactive';
    var text = (label != null) ? label : (key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '));
    return '<span class="sk-status sk-status--' + variant + '">' + _esc(text) + '</span>';
  }

  /* ── ALERT (inline injection) ───────────────────────────── */
  /* SokoniUI has no inline-alert-into-container feature       */

  var ALERT_ICON = { success: '✓', warn: '⚠', danger: '✕', info: 'ℹ', error: '✕' };

  function _alert(container, type, msg, dismissible) {
    if (!container) return;
    type = type || 'info';
    var icon = ALERT_ICON[type] || 'ℹ';
    var cssType = type === 'danger' ? 'danger' : (type === 'error' ? 'danger' : type);
    var dm = dismissible
      ? '<button class="sk-alert-dismiss" type="button" aria-label="Dismiss" ' +
        'onclick="this.closest(\'.sk-alert\').remove()">✕</button>'
      : '';
    var el = _ce('div', 'sk-alert sk-alert-' + cssType);
    el.setAttribute('role', 'alert');
    el.innerHTML =
      '<span class="sk-alert-icon">' + icon + '</span>' +
      '<span class="sk-alert-body"><span class="sk-alert-msg">' + _esc(msg) + '</span></span>' +
      dm;
    container.innerHTML = '';
    container.appendChild(el);
    return el;
  }

  /* ── FORM ───────────────────────────────────────────────── */

  function _formFieldError(input, msg) {
    if (!input) return;
    input.classList.add('sk-input-error');
    input.setAttribute('aria-invalid', 'true');
    var wrap = input.closest('.sk-form-group') || input.parentElement;
    if (!wrap) return;
    var err = wrap.querySelector('.sk-field-error');
    if (!err) {
      err = _ce('div', 'sk-field-error');
      input.insertAdjacentElement('afterend', err);
    }
    err.textContent = msg || 'This field is required';
    err.classList.add('visible');
    if (input.scrollIntoView) input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    input.focus();
  }

  function _formFieldClear(input) {
    if (!input) return;
    input.classList.remove('sk-input-error');
    input.removeAttribute('aria-invalid');
    var wrap = input.closest('.sk-form-group') || input.parentElement;
    if (!wrap) return;
    var err = wrap.querySelector('.sk-field-error');
    if (err) { err.textContent = ''; err.classList.remove('visible'); }
  }

  function _formValidate(formEl) {
    if (!formEl) return true;
    var valid = true;
    var firstInvalid = null;
    formEl.querySelectorAll('[required]').forEach(function (f) {
      _formFieldClear(f);
      var val = (f.type === 'checkbox' || f.type === 'radio') ? f.checked : (f.value || '').trim();
      if (!val) {
        var label = formEl.querySelector('label[for="' + f.id + '"]');
        var name  = (label ? label.textContent : f.name || 'This field').replace(/\s*\*\s*$/, '');
        _formFieldError(f, name + ' is required');
        if (!firstInvalid) firstInvalid = f;
        valid = false;
      }
    });
    formEl.querySelectorAll('input[type="email"]').forEach(function (f) {
      if (f.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.value)) {
        _formFieldError(f, 'Enter a valid email address');
        if (!firstInvalid) firstInvalid = f;
        valid = false;
      }
    });
    formEl.querySelectorAll('input[type="tel"]').forEach(function (f) {
      if (f.value && f.value.replace(/\D/g, '').length < 9) {
        _formFieldError(f, 'Enter a valid phone number');
        if (!firstInvalid) firstInvalid = f;
        valid = false;
      }
    });
    if (firstInvalid) firstInvalid.focus();
    return valid;
  }

  function _formClearAll(formEl) {
    if (!formEl) return;
    formEl.querySelectorAll('.sk-input-error').forEach(function (f) { _formFieldClear(f); });
  }

  /* ── SEARCH ─────────────────────────────────────────────── */

  function _searchInit(inputEl, onSearch, opts) {
    if (!inputEl) return;
    opts = opts || {};
    var delay = opts.delay || 280;
    var minLen = opts.minLength || 0;
    var wrap = inputEl.closest('.sk-search-wrap');
    var results = wrap && wrap.querySelector('.sk-search-results');

    var doSearch = _debounce(function (val) {
      if (val.length < minLen) {
        if (results) results.classList.remove('open');
        return;
      }
      if (onSearch) onSearch(val, results);
    }, delay);

    inputEl.addEventListener('input', function () {
      var val = this.value;
      if (wrap) wrap.classList.toggle('has-value', !!val.trim());
      doSearch(val.trim());
    });

    inputEl.addEventListener('keydown', function (e) {
      if (!results || !results.classList.contains('open')) return;
      var items = results.querySelectorAll('.sk-search-result');
      var focused = results.querySelector('.sk-search-result.focused');
      var idx = focused ? Array.prototype.indexOf.call(items, focused) : -1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        var next = items[idx + 1] || items[0];
        if (focused) focused.classList.remove('focused');
        if (next) next.classList.add('focused');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        var prev = items[idx - 1] || items[items.length - 1];
        if (focused) focused.classList.remove('focused');
        if (prev) prev.classList.add('focused');
      } else if (e.key === 'Enter' && focused) {
        e.preventDefault();
        focused.click();
      } else if (e.key === 'Escape') {
        if (results) results.classList.remove('open');
      }
    });

    /* Clear button */
    if (wrap) {
      var clr = wrap.querySelector('.sk-search-clear');
      if (clr) {
        clr.addEventListener('click', function () {
          inputEl.value = '';
          wrap.classList.remove('has-value');
          if (results) results.classList.remove('open');
          if (onSearch) onSearch('', results);
          inputEl.focus();
        });
      }
    }

    /* Close on outside click */
    document.addEventListener('click', function (e) {
      if (results && wrap && !wrap.contains(e.target)) {
        results.classList.remove('open');
      }
    }, true);

    return {
      open: function ()  { if (results) results.classList.add('open'); },
      close: function () { if (results) results.classList.remove('open'); },
      clear: function () { inputEl.value = ''; if (wrap) wrap.classList.remove('has-value'); },
    };
  }

  /* ── TABS ─────────────────────────────────────────────── */

  function _tabsInit(tabsEl, opts) {
    if (!tabsEl) return;
    opts = opts || {};
    var tabs   = tabsEl.querySelectorAll('.sk-tab');
    var panelWrap = opts.panels || tabsEl.parentElement.querySelector('.sk-tab-panels');

    function activate(tab) {
      tabs.forEach(function (t) {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });
      if (panelWrap) {
        var key = tab.dataset.tab;
        panelWrap.querySelectorAll('.sk-tab-panel').forEach(function (p) {
          p.classList.toggle('active', p.dataset.tab === key);
        });
      }
      if (opts.onChange) opts.onChange(tab.dataset.tab, tab);
    }

    tabs.forEach(function (tab) {
      tab.setAttribute('role', 'tab');
      tab.setAttribute('tabindex', '0');
      tab.addEventListener('click', function () { activate(tab); });
      tab.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(tab); }
      });
    });

    /* Activate first active or first tab */
    var initial = tabsEl.querySelector('.sk-tab.active') || tabs[0];
    if (initial) activate(initial);
  }

  /* ── DROPDOWN ───────────────────────────────────────────── */

  function _dropdownInit(triggerEl, opts) {
    if (!triggerEl) return;
    opts = opts || {};
    var wrap = triggerEl.closest('.sk-dropdown') || triggerEl.parentElement;
    var menu = opts.menu || (wrap && wrap.querySelector('.sk-dropdown-menu'));
    if (!menu) return;

    triggerEl.setAttribute('aria-haspopup', 'true');
    triggerEl.setAttribute('aria-expanded', 'false');

    function open() {
      wrap.classList.add('open');
      triggerEl.setAttribute('aria-expanded', 'true');
      /* First item focus */
      var first = menu.querySelector('.sk-dropdown-item');
      if (first) setTimeout(function () { first.focus(); }, 50);
    }
    function close() {
      wrap.classList.remove('open');
      triggerEl.setAttribute('aria-expanded', 'false');
    }
    function toggle() { wrap.classList.contains('open') ? close() : open(); }

    triggerEl.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    triggerEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      if (e.key === 'Escape') close();
    });

    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) close();
    });

    menu.addEventListener('keydown', function (e) {
      var items = menu.querySelectorAll('.sk-dropdown-item:not([disabled])');
      var focused = menu.querySelector('.sk-dropdown-item:focus');
      var idx = focused ? Array.prototype.indexOf.call(items, focused) : -1;
      if (e.key === 'ArrowDown') { e.preventDefault(); var n = items[(idx + 1) % items.length]; if (n) n.focus(); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); var p = items[(idx - 1 + items.length) % items.length]; if (p) p.focus(); }
      if (e.key === 'Escape')    { close(); triggerEl.focus(); }
    });

    return { open: open, close: close, toggle: toggle };
  }

  /* ── BADGE FACTORY ──────────────────────────────────────── */

  var BADGE_TYPES = ['accent', 'success', 'warn', 'danger', 'info', 'neutral',
                     'green', 'red', 'yellow', 'blue', 'purple', 'gray'];

  function badge(text, type) {
    type = BADGE_TYPES.indexOf(type) !== -1 ? type : 'neutral';
    return '<span class="sk-badge sk-badge-' + type + '">' + _esc(text) + '</span>';
  }

  /* ── PUBLIC API ─────────────────────────────────────────── */

  g.SK = {
    _v: '1.0.0',

    toast: toast,

    dialog: {
      open:    _dialogOpen,
      alert:   _dialogAlert,
      confirm: _dialogConfirm,
      close:   _dialogClose,
    },

    loading: {
      btn:      _loadingBtn,
      btnDone:  _loadingBtnDone,
      page:     _loadingPage,
      pageDone: _loadingPageDone,
    },

    skeleton: {
      cards: _skelCards,
      list:  _skelList,
      clear: _skelClear,
    },

    empty: _empty,
    statusChip: _statusChip,
    alert: _alert,

    form: {
      validate:   _formValidate,
      clearAll:   _formClearAll,
      fieldError: _formFieldError,
      fieldClear: _formFieldClear,
    },

    search: { init: _searchInit, debounce: _debounce },
    tabs:   { init: _tabsInit },
    dropdown: { init: _dropdownInit },

    badge: badge,
    esc:   _esc,
    uid:   _uid,
  };

  /* Emit ready event so pages can listen */
  document.dispatchEvent(new CustomEvent('sk:ready', { detail: { version: '1.0.0' } }));

}(window));
