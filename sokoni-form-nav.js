/*!
 * SokoniFormNav v1.0
 * Sticky-form navigation guard for SOKONI long-form pages.
 *
 * Usage:
 *   SokoniFormNav.init({ backUrl, title, draftKey?, onSaveDraft? })
 *
 * API:
 *   SokoniFormNav.goBack()      — call from in-app back/close buttons
 *   SokoniFormNav.markClean()   — reset dirty flag (e.g. after save)
 *   SokoniFormNav.markDirty()   — force dirty (e.g. after loading draft)
 *   SokoniFormNav.isDirty()     — boolean
 *   SokoniFormNav.saveDraft(d)  — persist to localStorage (requires draftKey)
 *   SokoniFormNav.loadDraft()   — retrieve from localStorage
 *   SokoniFormNav.clearDraft()  — remove from localStorage
 */
(function (w) {
  'use strict';

  let _dirty = false;
  let _opts  = {};
  let _inited = false;

  const FN = w.SokoniFormNav = {

    init(opts) {
      if (_inited) return;
      _inited = true;

      _opts = Object.assign({
        backUrl:     null,
        title:       (document.title || '').split('—')[0].trim(),
        draftKey:    null,
        onSaveDraft: null,
        warnMsg:     'You have unsaved changes. Leave this page?',
      }, opts);

      // Detect any input change anywhere on the page
      document.addEventListener('input',  _mark, true);
      document.addEventListener('change', _mark, true);

      // Browser-level guard: covers tab close, address bar, Android back, iOS swipe-back in Safari
      w.addEventListener('beforeunload', _beforeUnload);

      // Inject confirmation dialog into DOM (only once)
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _injectDialog);
      } else {
        _injectDialog();
      }
    },

    markClean() { _dirty = false; },
    markDirty() { _dirty = true; },
    isDirty()   { return _dirty; },

    // Call this from any in-app back/close button.
    // Shows the unsaved-changes dialog when dirty; navigates immediately when clean.
    goBack() {
      if (_dirty) { _showDialog(); } else { _doNav(); }
    },

    saveDraft(data) {
      const k = _opts.draftKey;
      if (!k) return;
      try { localStorage.setItem(k, JSON.stringify({ ts: Date.now(), d: data })); } catch (e) {}
    },

    loadDraft() {
      const k = _opts.draftKey;
      if (!k) return null;
      try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (e) { return null; }
    },

    clearDraft() {
      const k = _opts.draftKey;
      if (k) try { localStorage.removeItem(k); } catch (e) {}
    },
  };

  // ── private ──────────────────────────────────────────────────────────────

  function _mark() { _dirty = true; }

  function _beforeUnload(e) {
    if (!_dirty) return;
    e.preventDefault();
    e.returnValue = _opts.warnMsg;
    return _opts.warnMsg;
  }

  function _doNav() {
    // Remove guard before navigating so we don't trigger our own handler
    w.removeEventListener('beforeunload', _beforeUnload);
    if (_opts.backUrl) {
      w.location.href = _opts.backUrl;
    } else if (history.length > 1) {
      history.back();
    } else {
      w.location.href = 'index.html';
    }
  }

  function _gatherFormData() {
    const out = {};
    document.querySelectorAll('input[name],select[name],textarea[name]').forEach(el => {
      if (el.type === 'password') return; // never persist passwords
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
  }

  function _injectDialog() {
    if (document.getElementById('sfn-dlg')) return;

    // Styles
    const s = document.createElement('style');
    s.textContent =
      '#sfn-dlg{display:none;position:fixed;inset:0;z-index:var(--sk-z-sheet,100010);align-items:center;' +
        'justify-content:center;padding:20px;box-sizing:border-box}' +
      '#sfn-dlg.sfn-on{display:flex}' +
      '#sfn-bg{position:absolute;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(6px)}' +
      '#sfn-box{position:relative;background:#0d0d0d;border:1px solid rgba(113,255,0,.22);' +
        'border-radius:18px;padding:26px 22px;max-width:340px;width:100%;z-index:1;' +
        'animation:sfn-pop .16s ease;box-shadow:0 20px 60px rgba(0,0,0,.7)}' +
      '@keyframes sfn-pop{from{opacity:0;transform:scale(.93)}to{opacity:1;transform:scale(1)}}' +
      '#sfn-h{font-size:17px;font-weight:700;color:#fff;margin-bottom:6px}' +
      '#sfn-p{font-size:13px;color:rgba(255,255,255,.55);margin:0 0 22px;line-height:1.55}' +
      '#sfn-btns{display:flex;flex-direction:column;gap:8px}' +
      '.sfn-btn{padding:13px 16px;border-radius:10px;font-size:13px;font-weight:600;' +
        'border:none;cursor:pointer;width:100%;min-height:44px;transition:opacity .15s}' +
      '.sfn-btn:active{opacity:.75}' +
      '#sfn-keep{background:rgba(113,255,0,.12);color:#71ff00;' +
        'border:1px solid rgba(113,255,0,.3)!important}' +
      '#sfn-draft{background:rgba(255,255,255,.07);color:#fff;' +
        'border:1px solid rgba(255,255,255,.13)!important}' +
      '#sfn-leave{background:rgba(255,59,59,.08);color:#ff6464;' +
        'border:1px solid rgba(255,59,59,.22)!important}';
    document.head.appendChild(s);

    // Markup
    const el = document.createElement('div');
    el.id = 'sfn-dlg';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'sfn-h');
    el.innerHTML =
      '<div id="sfn-bg"></div>' +
      '<div id="sfn-box">' +
        '<div id="sfn-h">Unsaved Changes</div>' +
        '<p id="sfn-p">You have unsaved changes. What would you like to do?</p>' +
        '<div id="sfn-btns">' +
          '<button class="sfn-btn" id="sfn-keep">Continue Editing</button>' +
          '<button class="sfn-btn" id="sfn-draft">Save Draft &amp; Exit</button>' +
          '<button class="sfn-btn" id="sfn-leave">Discard &amp; Leave</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    document.getElementById('sfn-bg').addEventListener('click', _hideDialog);
    document.getElementById('sfn-keep').addEventListener('click', _hideDialog);

    document.getElementById('sfn-draft').addEventListener('click', function () {
      const data = _opts.onSaveDraft ? _opts.onSaveDraft() : _gatherFormData();
      FN.saveDraft(data);
      _dirty = false;
      _hideDialog();
      _doNav();
    });

    document.getElementById('sfn-leave').addEventListener('click', function () {
      _dirty = false;
      _hideDialog();
      _doNav();
    });
  }

  function _showDialog() {
    // Show "Save Draft" only if persistence is configured
    const draftBtn = document.getElementById('sfn-draft');
    if (draftBtn) {
      draftBtn.style.display = (_opts.draftKey || _opts.onSaveDraft) ? '' : 'none';
    }
    const d = document.getElementById('sfn-dlg');
    if (d) {
      d.classList.add('sfn-on');
      setTimeout(function () {
        const keep = document.getElementById('sfn-keep');
        if (keep) keep.focus();
      }, 50);
    }
  }

  function _hideDialog() {
    const d = document.getElementById('sfn-dlg');
    if (d) d.classList.remove('sfn-on');
  }

}(window));
