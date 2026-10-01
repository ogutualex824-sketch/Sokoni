/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Report Wizard — sokoni-report-wizard.js (community C2, 2026-10-01)

   A three-step report flow on the ONE report authority:
     1. Reason   — the SERVER's list (SokoniReport.reasons → tsGetReportReasons). No client list exists; if the list
                   cannot be loaded the wizard says so and offers a retry — it never invents reasons.
     2. Details  — required for a reason the server marks detailRequired ('other'), optional otherwise, capped at the
                   server's detailMax.
     3. Review   — what will be sent, then Submit → SokoniReport.send → tsReportContent.
   "Report received" is shown ONLY after the server has answered. A refusal (already reported, own product, signed out,
   App Check, network) is shown as what it is, and the report is NOT claimed as sent.

   Reports are private: the seller sees that a listing was reported and the outcome, never who reported it.

   Accessibility: role=dialog + aria-modal, labelled; a focus trap; Escape closes (not while sending); focus returns to
   the opener; the step is announced (aria-live); reasons are a native radio group in a fieldset; every target ≥44px.

   API: SokoniReportWizard.open({ entityType: 'product', entityId, entityName?, opener? }) → Promise<result|null>
        (resolves with the server's { ok, reportId } when sent, null when closed without sending)
   Depends on: sokoni-trust.js (SokoniReport). Loads no Firebase itself.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  if (!root || !root.document) return;
  var doc = root.document;

  var CSS = [
    '.srw-scrim{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:16px}',
    '.srw{box-sizing:border-box;width:100%;max-width:480px;max-height:calc(100vh - 32px);overflow:auto;background:#111;color:#f2f2f2;',
    'border:1px solid rgba(113,255,0,.22);border-radius:20px;padding:20px;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    '.srw *{box-sizing:border-box}',
    '.srw-hd{display:flex;align-items:flex-start;gap:10px;margin-bottom:6px}',
    '.srw-hd h2{flex:1;margin:0;font-size:17px;font-weight:800;line-height:1.3}',
    '.srw-x{flex:0 0 44px;width:44px;height:44px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#fff;font-size:22px;cursor:pointer}',
    '.srw-step{font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.55);margin:0 0 12px}',
    '.srw-sub{font-size:13px;color:rgba(255,255,255,.6);margin:0 0 14px;overflow-wrap:anywhere}',
    '.srw fieldset{border:0;margin:0;padding:0;display:grid;gap:8px}',
    '.srw legend{font-weight:800;font-size:14px;margin-bottom:8px;padding:0}',
    '.srw-opt{display:flex;gap:12px;align-items:flex-start;min-height:44px;padding:11px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.12);cursor:pointer;background:rgba(255,255,255,.03)}',
    '.srw-opt:has(input:checked){border-color:rgba(113,255,0,.55);background:rgba(113,255,0,.08)}',
    '.srw-opt input{width:20px;height:20px;margin:2px 0 0;accent-color:#71ff00;flex:0 0 auto}',
    '.srw-opt b{display:block;font-size:14px}.srw-opt small{display:block;font-size:12.5px;color:rgba(255,255,255,.6);margin-top:2px}',
    '.srw label.srw-lbl{display:block;font-weight:800;font-size:14px;margin-bottom:6px}',
    '.srw textarea{width:100%;min-height:120px;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:#1a1a1a;color:#fff;font:inherit;font-size:16px;resize:vertical}',
    '.srw textarea:focus,.srw-opt:focus-within{outline:2px solid #71ff00;outline-offset:2px}',
    '.srw-count{font-size:12px;color:rgba(255,255,255,.55);text-align:right;margin-top:4px}',
    '.srw-help{font-size:12.5px;color:rgba(255,255,255,.6);margin-top:6px}',
    '.srw-review{display:grid;grid-template-columns:auto 1fr;gap:8px 12px;font-size:14px;margin:0 0 12px}',
    '.srw-review dt{color:rgba(255,255,255,.55)}.srw-review dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.srw-note{font-size:12.5px;color:rgba(255,255,255,.6);padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.04);margin:0 0 4px}',
    '.srw-err{color:#ff8a8d;font-size:13.5px;margin:12px 0 0;padding:10px 12px;border-radius:12px;background:rgba(255,90,95,.08);border:1px solid rgba(255,90,95,.3)}',
    '.srw-ok{text-align:center;padding:10px 4px}.srw-ok .ic{font-size:34px}.srw-ok h3{margin:8px 0 6px;font-size:17px}',
    '.srw-acts{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}',
    '.srw-btn{flex:1 1 120px;min-height:44px;padding:0 16px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;font:inherit;font-weight:800;font-size:14px;cursor:pointer}',
    '.srw-btn.pri{background:#71ff00;border-color:#71ff00;color:#000}',
    '.srw-btn[disabled]{opacity:.5;cursor:default}',
    '.srw-btn:focus-visible,.srw-x:focus-visible{outline:2px solid #71ff00;outline-offset:2px}',
    '.srw-state{padding:18px 6px;text-align:center;color:rgba(255,255,255,.7)}',
  ].join('');

  function el(tag, attrs, kids) {
    var n = doc.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'cls') n.className = attrs[k];
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return n;
  }

  var _open = null;

  function open(opts) {
    opts = opts || {};
    if (_open) { _open.focusFirst(); return _open.promise; }
    if (!doc.getElementById('srw-css')) { var st = doc.createElement('style'); st.id = 'srw-css'; st.textContent = CSS; doc.head.appendChild(st); }

    var S = {
      step: 0,              /* 0 signin-check | 1 reason | 2 details | 3 review | 4 done | 5 blocked (already/own/signin) */
      reasons: null, meta: null, loadErr: null,
      code: null, detail: '', err: null, busy: false, result: null, blocked: null,
    };
    var opener = opts.opener || doc.activeElement;
    var resolveP; var promise = new Promise(function (r) { resolveP = r; });
    var titleId = 'srwTitle', stepId = 'srwStep';
    var scrim = el('div', { cls: 'srw-scrim' });
    var box = el('div', { cls: 'srw', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': stepId });
    scrim.appendChild(box);
    doc.body.appendChild(scrim);
    var prevOverflow = doc.body.style.overflow; doc.body.style.overflow = 'hidden';

    function reason() { return (S.reasons || []).find(function (r) { return r.code === S.code; }) || null; }
    function detailRequired() { var r = reason(); return !!(r && r.detailRequired); }
    function minLen() { return (S.meta && S.meta.detailMinWhenRequired) || 10; }
    function maxLen() { return (S.meta && S.meta.detailMax) || 500; }

    function close(result) {
      if (S.busy) return;
      doc.removeEventListener('keydown', onKey, true);
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
      doc.body.style.overflow = prevOverflow;
      _open = null;
      try { if (opener && opener.focus) opener.focus(); } catch (_) {}
      resolveP(result || null);
    }
    function focusables() {
      return Array.prototype.filter.call(box.querySelectorAll('button,textarea,input,a[href]'), function (n) { return !n.disabled && n.offsetParent !== null; });
    }
    function focusFirst() {
      var pick = box.querySelector('[data-autofocus]') || focusables()[0];
      if (pick) try { pick.focus(); } catch (_) {}
    }
    function onKey(e) {
      if (!_open) return;
      if (e.key === 'Escape') { e.preventDefault(); close(S.result); return; }
      if (e.key === 'Tab') {
        var f = focusables(); if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    doc.addEventListener('keydown', onKey, true);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(S.result); });

    function btn(label, cls, onClick, extra) {
      var b = el('button', Object.assign({ type: 'button', cls: 'srw-btn' + (cls ? ' ' + cls : ''), text: label }, extra || {}));
      b.addEventListener('click', onClick);
      return b;
    }

    function header(title) {
      var x = el('button', { type: 'button', cls: 'srw-x', 'aria-label': 'Close report', text: '×' });
      x.addEventListener('click', function () { close(S.result); });
      var stepTxt = S.step >= 1 && S.step <= 3 ? 'Step ' + S.step + ' of 3' : '';
      return [el('div', { cls: 'srw-hd' }, [el('h2', { id: titleId, text: title }), x]),
        el('p', { cls: 'srw-step', id: stepId, 'aria-live': 'polite', text: stepTxt })];
    }

    function paint() {
      var keepDetail = box.querySelector('#srwDetail'); if (keepDetail) S.detail = keepDetail.value;
      box.innerHTML = '';
      var title = opts.entityType === 'product' ? 'Report this listing' : 'Report';
      var parts = header(S.step === 4 ? 'Report received' : title);
      parts.forEach(function (p) { box.appendChild(p); });
      if (opts.entityName && S.step >= 1 && S.step <= 3) box.appendChild(el('p', { cls: 'srw-sub', text: opts.entityName }));

      if (S.step === 0) {
        box.appendChild(el('div', { cls: 'srw-state', role: 'status', text: 'Checking your sign-in…' }));
      } else if (S.step === 5) {
        var b = S.blocked || {};
        box.appendChild(el('div', { cls: 'srw-ok' }, [el('div', { cls: 'ic', 'aria-hidden': 'true', text: b.icon || 'ℹ️' }),
          el('h3', { text: b.title || '' }), el('p', { cls: 'srw-sub', text: b.body || '' })]));
        var acts = el('div', { cls: 'srw-acts' });
        if (b.signin) {
          var a = el('a', { cls: 'srw-btn pri', href: 'login.html?next=' + encodeURIComponent(root.location.pathname + root.location.search), 'data-autofocus': true, text: 'Sign in' });
          a.style.display = 'inline-flex'; a.style.alignItems = 'center'; a.style.justifyContent = 'center'; a.style.textDecoration = 'none';
          acts.appendChild(a);
        }
        acts.appendChild(btn('Close', '', function () { close(S.result); }, b.signin ? {} : { 'data-autofocus': true }));
        box.appendChild(acts);
      } else if (S.step === 1) {
        if (!S.reasons && !S.loadErr) {
          box.appendChild(el('div', { cls: 'srw-state', role: 'status', text: 'Loading reasons…' }));
        } else if (S.loadErr) {
          box.appendChild(el('div', { cls: 'srw-err', role: 'alert', text: 'The list of reasons could not be loaded: ' + S.loadErr }));
          box.appendChild(el('div', { cls: 'srw-acts' }, [btn('Try again', 'pri', loadReasons, { 'data-autofocus': true }), btn('Cancel', '', function () { close(null); })]));
        } else {
          var fs = el('fieldset', {}, [el('legend', { text: 'What is wrong with it?' })]);
          S.reasons.forEach(function (r, i) {
            var inp = el('input', { type: 'radio', name: 'srwReason', value: r.code, id: 'srwR' + i, checked: S.code === r.code });
            inp.addEventListener('change', function () { S.code = r.code; S.err = null; paint(); var n = box.querySelector('#srwR' + i); if (n) n.focus(); });
            fs.appendChild(el('label', { cls: 'srw-opt', for: 'srwR' + i }, [inp, el('span', {}, [el('b', { text: r.label }), r.hint ? el('small', { text: r.hint }) : null])]));
          });
          box.appendChild(fs);
          if (S.err) box.appendChild(el('div', { cls: 'srw-err', role: 'alert', text: S.err }));
          box.appendChild(el('div', { cls: 'srw-acts' }, [btn('Cancel', '', function () { close(null); }),
            btn('Next', 'pri', function () { if (!S.code) { S.err = 'Choose a reason to continue.'; paint(); return; } S.err = null; S.step = 2; paint(); focusFirst(); })]));
        }
      } else if (S.step === 2) {
        var req = detailRequired();
        var r = reason();
        box.appendChild(el('p', { cls: 'srw-sub', text: 'Reason: ' + (r ? r.label : '—') }));
        box.appendChild(el('label', { cls: 'srw-lbl', for: 'srwDetail', text: req ? 'Describe the problem (required)' : 'Anything else we should know? (optional)' }));
        var ta = el('textarea', { id: 'srwDetail', maxlength: String(maxLen()), 'aria-describedby': 'srwCount srwHelp', 'aria-required': req ? 'true' : 'false', 'data-autofocus': true });
        ta.value = S.detail;
        var count = el('div', { cls: 'srw-count', id: 'srwCount', 'aria-live': 'polite', text: S.detail.length + ' / ' + maxLen() });
        ta.addEventListener('input', function () { S.detail = ta.value; count.textContent = ta.value.length + ' / ' + maxLen(); });
        box.appendChild(ta); box.appendChild(count);
        box.appendChild(el('p', { cls: 'srw-help', id: 'srwHelp', text: req ? 'At least ' + minLen() + ' characters. Do not include phone numbers or passwords.' : 'Do not include phone numbers or passwords.' }));
        if (S.err) box.appendChild(el('div', { cls: 'srw-err', role: 'alert', text: S.err }));
        box.appendChild(el('div', { cls: 'srw-acts' }, [btn('Back', '', function () { S.detail = ta.value; S.err = null; S.step = 1; paint(); focusFirst(); }),
          btn('Next', 'pri', function () {
            S.detail = ta.value;
            if (req && S.detail.trim().length < minLen()) { S.err = 'Please describe the problem in at least ' + minLen() + ' characters.'; paint(); var t = box.querySelector('#srwDetail'); if (t) t.focus(); return; }
            S.err = null; S.step = 3; paint(); focusFirst();
          })]));
      } else if (S.step === 3) {
        var rr = reason();
        box.appendChild(el('dl', { cls: 'srw-review' }, [
          el('dt', { text: 'Reason' }), el('dd', { text: rr ? rr.label : '—' }),
          el('dt', { text: 'Details' }), el('dd', { text: S.detail.trim() || 'None' }),
        ]));
        box.appendChild(el('p', { cls: 'srw-note', text: 'Reports are private. SOKONI reviews every report; the seller is never told who reported it. You can report a listing once.' }));
        if (S.err) box.appendChild(el('div', { cls: 'srw-err', role: 'alert', text: S.err }));
        box.appendChild(el('div', { cls: 'srw-acts' }, [
          btn('Back', '', function () { S.err = null; S.step = 2; paint(); focusFirst(); }, { disabled: S.busy }),
          btn(S.busy ? 'Sending…' : 'Submit report', 'pri', submit, { disabled: S.busy, 'data-autofocus': true, 'aria-busy': S.busy ? 'true' : 'false' }),
        ]));
      } else if (S.step === 4) {
        box.appendChild(el('div', { cls: 'srw-ok', role: 'status' }, [el('div', { cls: 'ic', 'aria-hidden': 'true', text: '✅' }),
          el('h3', { text: 'Thank you — SOKONI has your report' }),
          el('p', { cls: 'srw-sub', text: 'Our team will review it. The seller is not told who reported it.' })]));
        box.appendChild(el('div', { cls: 'srw-acts' }, [btn('Done', 'pri', function () { close(S.result); }, { 'data-autofocus': true })]));
      }
    }

    function block(kind) {
      S.blocked = {
        signin: { icon: '🔒', title: 'Sign in to report', body: 'Reports are tied to an account so they cannot be abused.', signin: true },
        already: { icon: 'ℹ️', title: 'You have already reported this', body: 'Our team is reviewing your report. You can report a listing once.' },
        own: { icon: 'ℹ️', title: 'This is your own listing', body: 'You cannot report your own product. Edit it from your merchant dashboard instead.' },
        gone: { icon: 'ℹ️', title: 'This listing no longer exists', body: 'There is nothing to report.' },
      }[kind];
      S.step = 5; paint(); focusFirst();
    }

    function loadReasons() {
      S.loadErr = null; S.reasons = null; paint();
      return root.SokoniReport.reasons(opts.entityType).then(function (r) {
        if (!_open) return;
        if (!r || !r.ok) { S.loadErr = (r && r.message) || 'please try again.'; paint(); focusFirst(); return; }
        if (!r.reasons.length) { S.loadErr = 'this kind of report has no reason list.'; paint(); focusFirst(); return; }
        S.reasons = r.reasons; S.meta = r; paint(); focusFirst();
      });
    }

    function submit() {
      if (S.busy) return;
      S.busy = true; S.err = null; paint();
      root.SokoniReport.send(opts.entityType, opts.entityId, S.code, S.detail.trim()).then(function (r) {
        S.busy = false;
        if (!_open) return;
        if (r && r.ok) { S.result = r; S.step = 4; paint(); focusFirst(); return; }
        var code = r && r.code;
        if (code === 'already-exists') return block('already');
        if (code === 'unauthenticated') return block('signin');
        if (code === 'failed-precondition') return block('own');
        if (code === 'not-found') return block('gone');
        /* NOT sent — say so, keep everything the person typed, let them retry */
        S.err = 'Your report was NOT sent: ' + ((r && r.message) || 'please try again.');
        paint(); focusFirst();
      });
    }

    _open = { promise: promise, focusFirst: focusFirst };
    paint(); focusFirst();

    if (!root.SokoniReport || typeof root.SokoniReport.send !== 'function') {
      S.step = 1; S.loadErr = 'reporting is not available on this page right now.'; paint(); focusFirst();
      return promise;
    }
    root.SokoniReport.currentUser().then(function (u) {
      if (!_open) return;
      if (!u) return block('signin');
      S.step = 1; loadReasons();
    });
    return promise;
  }

  root.SokoniReportWizard = { open: open };
}(typeof window !== 'undefined' ? window : null));
