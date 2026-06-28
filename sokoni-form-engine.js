/* ============================================================
   SOKONI Universal Form Engine — sokoni-form-engine.js v1.0
   Keyboard avoidance, auto-scroll, progress tracking, and
   multi-step wizard management — works for ALL registration
   forms, POS setup wizards, and modals platform-wide.
============================================================ */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  /* ── 1. VIRTUAL KEYBOARD AVOIDANCE ─────────────────────── */

  var _scrollTarget = null;

  /* Scroll the focused input into view above the keyboard.
     Uses visualViewport API when available (accurate on iOS/Android).
     Falls back to scrollIntoView with padding. */
  function _avoidKeyboard() {
    var el = document.activeElement;
    if (!el || !['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) return;

    /* Visual Viewport API — gives us the exact visible area */
    if (window.visualViewport) {
      var vv     = window.visualViewport;
      var rect   = el.getBoundingClientRect();
      var bottom = vv.offsetTop + vv.height;    /* Bottom of visible area */
      var inputBottom = rect.bottom + 24;       /* 24px breathing room below input */

      if (inputBottom > bottom) {
        /* Input is below the keyboard — scroll it up */
        var scrollable = _findScrollableParent(el);
        if (scrollable) {
          var offset = inputBottom - bottom;
          scrollable.scrollTop += offset;
        } else {
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
    } else {
      /* Fallback: always scroll into view with generous margin */
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /* Walk up the DOM to find the nearest scrollable ancestor */
  function _findScrollableParent(el) {
    var node = el.parentElement;
    while (node && node !== document.body) {
      var style = window.getComputedStyle(node);
      var overflow = style.overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /* Listen for focus events — delay slightly so keyboard has time to open */
  document.addEventListener('focusin', function (e) {
    var el = e.target;
    if (!['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) return;
    clearTimeout(_scrollTarget);
    _scrollTarget = setTimeout(_avoidKeyboard, 300);
  }, { passive: true });

  /* Also recheck when visual viewport resizes (keyboard open/close) */
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
      clearTimeout(_scrollTarget);
      _scrollTarget = setTimeout(_avoidKeyboard, 100);
    }, { passive: true });
  }

  /* ── 2. MULTI-STEP WIZARD MANAGER ──────────────────────── */

  window.SokoniWizard = (function () {

    /* Each wizard instance: { steps, current, total, container, onComplete, onStepChange } */
    var _instances = {};

    /**
     * Initialize a wizard.
     * @param {string}   id         Unique wizard ID (use container element ID)
     * @param {object}   opts
     * @param {string[]} opts.steps Array of step element IDs (in order)
     * @param {Function} opts.onComplete   Called when wizard completes
     * @param {Function} opts.onStepChange Called with (stepIndex, total) on each step change
     * @param {boolean}  opts.autoProgress Auto-advance on valid form
     */
    function init(id, opts) {
      var steps = opts.steps || [];
      if (!steps.length) return;

      _instances[id] = {
        steps:        steps,
        current:      0,
        total:        steps.length,
        onComplete:   opts.onComplete   || function () {},
        onStepChange: opts.onStepChange || function () {},
        autoProgress: !!opts.autoProgress,
      };

      _showStep(id, 0);
      _updateProgress(id);
    }

    function _showStep(id, index) {
      var inst = _instances[id];
      if (!inst) return;

      inst.steps.forEach(function (stepId, i) {
        var el = document.getElementById(stepId);
        if (!el) return;
        el.style.display = i === index ? '' : 'none';
        el.setAttribute('aria-hidden', String(i !== index));
      });

      inst.current = index;
      _scrollTop(id);
      _updateProgress(id);
      inst.onStepChange(index, inst.total);
    }

    /* Scroll the active step to top */
    function _scrollTop(id) {
      var inst = _instances[id];
      if (!inst) return;
      var el = document.getElementById(inst.steps[inst.current]);
      if (!el) return;
      /* Prefer scroll inside step body */
      var body = el.querySelector('.wizard-step-body, .step-body, .slide-body');
      if (body) { body.scrollTop = 0; return; }
      el.scrollTop = 0;
    }

    function _updateProgress(id) {
      var inst = _instances[id];
      if (!inst) return;
      /* Update any progress indicators with data-wizard-id attribute */
      var bars = document.querySelectorAll('[data-wizard-progress="' + id + '"]');
      bars.forEach(function (bar) {
        var pct = Math.round(((inst.current + 1) / inst.total) * 100);
        bar.style.width = pct + '%';
        bar.setAttribute('aria-valuenow', inst.current + 1);
        bar.setAttribute('aria-valuemax', inst.total);
      });
      /* Update step counters */
      var counters = document.querySelectorAll('[data-wizard-counter="' + id + '"]');
      counters.forEach(function (c) {
        c.textContent = (inst.current + 1) + ' / ' + inst.total;
      });
    }

    function next(id) {
      var inst = _instances[id];
      if (!inst) return;
      if (inst.current < inst.total - 1) {
        _showStep(id, inst.current + 1);
      } else {
        inst.onComplete();
      }
    }

    function prev(id) {
      var inst = _instances[id];
      if (!inst || inst.current <= 0) return;
      _showStep(id, inst.current - 1);
    }

    function goTo(id, index) {
      var inst = _instances[id];
      if (!inst || index < 0 || index >= inst.total) return;
      _showStep(id, index);
    }

    function current(id) {
      return _instances[id] ? _instances[id].current : -1;
    }

    function total(id) {
      return _instances[id] ? _instances[id].total : 0;
    }

    return { init: init, next: next, prev: prev, goTo: goTo, current: current, total: total };
  }());

  /* ── 3. FORM VALIDATION HELPER ──────────────────────────── */

  window.SokoniFormValidator = (function () {

    /* Validate all required fields within a container element.
       Returns { valid: bool, firstError: HTMLElement | null } */
    function validateStep(containerEl) {
      if (!containerEl) return { valid: true, firstError: null };
      var fields = containerEl.querySelectorAll('[required], [data-required]');
      var firstError = null;
      var valid = true;

      fields.forEach(function (field) {
        var isEmpty = !field.value || !field.value.trim();
        if (isEmpty) {
          valid = false;
          _markError(field);
          if (!firstError) firstError = field;
        } else {
          _clearError(field);
        }
      });

      if (firstError) {
        firstError.focus();
        firstError.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }

      return { valid: valid, firstError: firstError };
    }

    function _markError(field) {
      field.classList.add('sk-field-error');
      field.setAttribute('aria-invalid', 'true');
      /* Show sibling error message if it exists */
      var err = field.parentElement && field.parentElement.querySelector('.sk-error-msg, .field-error, .error-message');
      if (err) err.style.display = 'block';
    }

    function _clearError(field) {
      field.classList.remove('sk-field-error');
      field.setAttribute('aria-invalid', 'false');
      var err = field.parentElement && field.parentElement.querySelector('.sk-error-msg, .field-error, .error-message');
      if (err) err.style.display = 'none';
    }

    /* Live validation — clear errors as user types */
    document.addEventListener('input', function (e) {
      var field = e.target;
      if (!['INPUT','TEXTAREA','SELECT'].includes(field.tagName)) return;
      if (field.value && field.value.trim()) _clearError(field);
    }, { passive: true });

    return { validateStep: validateStep };
  }());

  /* ── 4. SAFE-AREA CSS VARS ──────────────────────────────── */

  /* Write safe-area values to CSS vars so inline styles can use them */
  function _writeSafeAreaVars() {
    var s = document.documentElement.style;
    /* Create a temporary element to read computed env() values */
    var probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;top:env(safe-area-inset-top,0px);' +
      'left:env(safe-area-inset-left,0px);' +
      'bottom:env(safe-area-inset-bottom,0px);' +
      'right:env(safe-area-inset-right,0px);' +
      'pointer-events:none;visibility:hidden;width:1px;height:1px;';
    document.body.appendChild(probe);
    var cs = window.getComputedStyle(probe);
    s.setProperty('--safe-top',    cs.top    || '0px');
    s.setProperty('--safe-left',   cs.left   || '0px');
    s.setProperty('--safe-bottom', cs.bottom || '0px');
    s.setProperty('--safe-right',  cs.right  || '0px');
    document.body.removeChild(probe);
  }

  /* Run after load to pick up safe area values */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _writeSafeAreaVars);
  } else {
    _writeSafeAreaVars();
  }

  window.addEventListener('resize', _writeSafeAreaVars, { passive: true });
  window.addEventListener('orientationchange', _writeSafeAreaVars, { passive: true });

  /* ── 5. AUTO-DETECT AND FIX OVERFLOW ISSUES ─────────────── */

  /* Run once after DOM loads — fix any container that has overflow:hidden
     but contains form fields, making fields inaccessible. */
  function _autoFixOverflow() {
    /* Only run in contexts that have forms */
    var forms = document.querySelectorAll('form, [data-wizard], [role="dialog"]');
    forms.forEach(function (form) {
      /* Check if form fields are clipped by a parent with overflow:hidden */
      var fields = form.querySelectorAll('input, select, textarea');
      if (!fields.length) return;

      /* Find the first scrollable or overflow:hidden ancestor */
      var ancestor = form.parentElement;
      var depth = 0;
      while (ancestor && ancestor !== document.body && depth < 8) {
        var style = window.getComputedStyle(ancestor);
        if (style.overflow === 'hidden' || style.overflowY === 'hidden') {
          /* Don't fix if it's a top-level layout container (full page) */
          var h = ancestor.getBoundingClientRect().height;
          if (h < window.innerHeight * 0.95) {
            ancestor.style.overflowY = 'auto';
            ancestor.style.webkitOverflowScrolling = 'touch';
          }
        }
        ancestor = ancestor.parentElement;
        depth++;
      }
    });
  }

  /* Run after short delay to allow framework to render */
  if (document.readyState === 'complete') {
    setTimeout(_autoFixOverflow, 500);
  } else {
    window.addEventListener('load', function () { setTimeout(_autoFixOverflow, 500); });
  }

  /* ── 6. PROGRESS BAR BUILDER ────────────────────────────── */

  /* Build a reusable progress bar — call from wizard HTML or JS */
  window.SokoniProgressBar = function (containerId, total, labels) {
    var container = document.getElementById(containerId);
    if (!container) return null;

    labels = labels || [];

    var html =
      '<div class="sk-progress-bar" role="progressbar" aria-valuemin="1" aria-valuemax="' + total + '" aria-valuenow="1">' +
        '<div class="sk-progress-track">' +
          '<div class="sk-progress-fill" style="width:' + Math.round(100 / total) + '%"></div>' +
        '</div>';

    if (labels.length) {
      html += '<div class="sk-progress-labels">';
      labels.forEach(function (label, i) {
        html += '<span class="sk-progress-label' + (i === 0 ? ' active' : '') + '">' + label + '</span>';
      });
      html += '</div>';
    }

    html += '</div>';
    container.innerHTML = html;

    return {
      update: function (step) {
        var fill = container.querySelector('.sk-progress-fill');
        if (fill) fill.style.width = Math.round(((step + 1) / total) * 100) + '%';
        var bar = container.querySelector('.sk-progress-bar');
        if (bar) bar.setAttribute('aria-valuenow', step + 1);
        var lbls = container.querySelectorAll('.sk-progress-label');
        lbls.forEach(function (l, i) { l.classList.toggle('active', i === step); });
      }
    };
  };

}());
