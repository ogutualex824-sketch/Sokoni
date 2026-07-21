/* ============================================================================
   SOKONI — Verification Code Field (single input)
   ----------------------------------------------------------------------------
   ONE premium verification input, mounted by three pages that each used to ship
   their own six-box grid (.otp-digit / .otp-b / .otpb) with three copies of the
   focus-jumping logic.

   Why a single field, not six boxes:

     · iOS SMS AutoFill fills exactly ONE field. In a six-box grid Safari fills
       the first box with the whole code, the maxlength="1" truncates it to one
       digit, and the other five stay empty — the "tap the suggestion" path was
       broken by construction.
     · Pasting "899297" into box 3 used to scatter digits from box 3 onward.
     · Android's keyboard suggestion has the same one-field assumption.

   API — one call, no page-level event wiring:

     const otp = SokoniOtp.mount('#otpMount', {
       length:     6,
       onComplete: (code) => verify(code),   // fires once, when full
       label:      'Verification code',
     });

     otp.value()            → '899297'
     otp.clear()            → wipe + re-arm (call on resend / failed attempt)
     otp.focus()
     otp.error(true|false)  → aria-invalid + red border
     otp.destroy()          → aborts the WebOTP listener

   The caller keeps its own verify function and its own backend call. This
   component never talks to a server.
============================================================================ */
(function (global) {
  'use strict';

  /* Styling lives with the component so the three pages cannot drift apart again.
     Every colour resolves through a CSS var with a fallback, so each page's own
     premium theme (--acc / --sk-accent) drives it and page CSS can still override. */
  var CSS = [
    /* Four stylesheets carry a global iOS-zoom guard on inputs. The strongest is
       sokoni-premium-v2.css:

         input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"])
           { font-size: max(16px, 1em) !important }

       Every :not() contributes its argument's specificity, so that selector scores (0,4,1)
       WITH !important — it outranks any class-based rule this component could reasonably
       write, and the field would render at a flat 16px with no tracking. The font-size is
       therefore applied inline with priority at mount (see setFont); an inline !important
       is the one thing a stylesheet !important cannot outrank, and it ends the arms race
       instead of escalating it.

       The guard's PURPOSE is preserved: it exists to stop iOS zooming the viewport when a
       sub-16px field takes focus, and 24px is well above that 16px floor.

       --sk-otp-fs keeps the size responsive — the media query below moves the variable,
       and the inline declaration reads through to it. */
    '.sk-otp{position:relative;--sk-otp-fs:24px}',
    '.sk-otp-in{',
    /* 16px minimum, or iOS Safari zooms the viewport on focus. 24px here because a
       verification code is the one thing the user is reading back off a lock screen. */
    '  width:100%;box-sizing:border-box;display:block;',
    '  min-height:56px;padding:14px 16px;',
    '  font-size:24px;font-weight:700;font-family:inherit;',
    '  text-align:center;',
    /* Tracking makes six digits legible at a glance. text-indent cancels the trailing
       letter-space that would otherwise push the centred text half a character left. */
    '  letter-spacing:.42em;text-indent:.42em;',
    '  font-variant-numeric:tabular-nums;',
    '  color:var(--text,var(--txt,#fff));',
    '  background:var(--surf2,var(--surface,rgba(255,255,255,.05)));',
    '  border:1px solid var(--border,var(--bor,rgba(255,255,255,.14)));',
    '  border-radius:var(--r,12px);',
    '  outline:none;transition:border-color .15s ease,box-shadow .15s ease;',
    '}',
    '.sk-otp-in::placeholder{',
    '  font-size:15px;font-weight:600;letter-spacing:normal;text-indent:0;',
    '  color:var(--muted,rgba(255,255,255,.38));',
    '}',
    '.sk-otp-in:focus{',
    '  border-color:var(--acc,var(--sk-accent,#71ff00));',
    '  box-shadow:0 0 0 3px color-mix(in srgb,var(--acc,#71ff00) 18%,transparent);',
    '}',
    '.sk-otp-in.is-full{border-color:var(--acc,var(--sk-accent,#71ff00))}',
    '.sk-otp-in[aria-invalid="true"]{border-color:#ff3d3d}',
    '.sk-otp-in:disabled{opacity:.6}',
    '.sk-otp-hint{',
    '  margin:7px 2px 0;font-size:11px;line-height:1.4;',
    '  color:var(--muted,rgba(255,255,255,.38));text-align:center;',
    '}',
    /* Still above the 16px no-zoom floor on the narrowest phones. */
    '@media (max-width:360px){.sk-otp{--sk-otp-fs:21px}.sk-otp-in{letter-spacing:.3em;text-indent:.3em}}',

    /* ── 6-box grid (boxes: true mode) ──────────────────────────────────────── */
    '.sk-otp-boxes{display:flex;gap:8px;justify-content:center;width:100%;}',
    '.sk-otp-box{',
    '  flex:1;min-width:0;max-width:52px;aspect-ratio:1/1;padding:0;',
    '  text-align:center;',
    '  font-weight:700;font-variant-numeric:tabular-nums;',
    '  color:var(--text,var(--txt,#fff));',
    '  background:var(--surf2,var(--surface,rgba(255,255,255,.07)));',
    '  border:1.5px solid var(--border,var(--bor,rgba(255,255,255,.14)));',
    '  border-radius:var(--r,12px);',
    '  outline:none;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease;',
    '  cursor:text;caret-color:transparent;',
    '  -webkit-tap-highlight-color:transparent;',
    '}',
    '.sk-otp-box:focus{',
    '  border-color:var(--acc,var(--sk-accent,#71ff00));',
    '  box-shadow:0 0 0 3px color-mix(in srgb,var(--acc,#71ff00) 18%,transparent);',
    '  background:rgba(255,255,255,.1);',
    '}',
    '.sk-otp-box.is-full{border-color:var(--acc,var(--sk-accent,#71ff00));}',
    '.sk-otp-box[aria-invalid="true"],.sk-otp-box.is-error{border-color:#ff3d3d;box-shadow:0 0 0 3px rgba(255,61,61,.12);}',
    '.sk-otp-box:disabled{opacity:.5;}',
    '@media (max-width:380px){.sk-otp-boxes{gap:6px;}}',
  ].join('');

  function injectCss() {
    if (document.getElementById('sk-otp-css')) return;
    var s = document.createElement('style');
    s.id = 'sk-otp-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  var _seq = 0;

  function mount(target, opts) {
    opts = opts || {};
    var host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) return null;

    injectCss();

    var len   = opts.length || 6;
    var id    = opts.id || ('sk-otp-' + (++_seq));

    /* 6-box grid mode: individual digit inputs with auto-advance, backspace nav,
       paste distribution, and iOS AutoFill compat. */
    if (opts.boxes) return mountBoxes(host, opts, len, id);

    var hintId = id + '-hint';

    var wrap = document.createElement('div');
    wrap.className = 'sk-otp';

    var input = document.createElement('input');
    input.id = id;
    input.className = 'sk-otp-in';
    /* type=text, NOT number: type=number ignores maxlength, offers a spinner, and on
       several Android keyboards suppresses the SMS suggestion strip entirely. */
    input.type = 'text';
    input.inputMode = 'numeric';
    input.setAttribute('pattern', '[0-9]*');
    /* The two attributes that make one-tap autofill work. iOS reads one-time-code;
       Android/Gboard reads the same token to offer the code above the keyboard. */
    input.autocomplete = 'one-time-code';
    input.name = opts.name || 'one-time-code';
    input.maxLength = len;
    input.placeholder = opts.placeholder || (len + '-digit verification code');
    input.setAttribute('aria-label', opts.label || 'Verification code');
    input.setAttribute('aria-describedby', hintId);
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.spellcheck = false;
    input.enterKeyHint = 'go';

    var hint = document.createElement('p');
    hint.className = 'sk-otp-hint';
    hint.id = hintId;
    hint.textContent = opts.hint || 'Paste the code, or tap the suggestion above your keyboard.';
    /* Announce "code complete" / errors without stealing focus from the field. */
    hint.setAttribute('aria-live', 'polite');

    /* The only declaration a stylesheet !important cannot beat. See the note on the
       zoom-guard rules above. Reads --sk-otp-fs so the media query still drives it. */
    input.style.setProperty('font-size', 'var(--sk-otp-fs, 24px)', 'important');

    wrap.appendChild(input);
    wrap.appendChild(hint);
    host.innerHTML = '';
    host.appendChild(wrap);

    var fired = false;          /* onComplete fires once per distinct full code */
    var lastFired = '';
    var ac = null;              /* WebOTP AbortController */

    function sanitize(raw) {
      /* Strips spaces, dashes, invisible characters and anything a paste drags in
         ("Your code is 899297" → "899297"). */
      return String(raw || '').replace(/\D+/g, '').slice(0, len);
    }

    function maybeComplete() {
      var v = input.value;
      if (v.length !== len) { fired = false; return; }
      if (fired && v === lastFired) return;   /* autofill + input can both land */
      fired = true;
      lastFired = v;
      if (typeof opts.onComplete === 'function') {
        /* A tick of breathing room so the user SEES the code land in the field
           before the button flips to "Verifying…". Instant submit reads as a glitch. */
        setTimeout(function () { opts.onComplete(v); }, 120);
      }
    }

    function onInput() {
      var clean = sanitize(input.value);
      if (clean !== input.value) {
        /* Rewriting .value resets the caret to the end, which is exactly where it
           belongs after we drop a non-digit — but only touch it when we changed
           something, or we'd break mid-string Backspace editing. */
        input.value = clean;
      }
      input.classList.toggle('is-full', clean.length === len);
      if (clean.length < len) input.setAttribute('aria-invalid', 'false');
      maybeComplete();
    }

    input.addEventListener('input', onInput);

    /* Safari fires neither `input` nor `change` reliably for AutoFill on every iOS
       version; `change` on blur is the belt to `input`'s braces. */
    input.addEventListener('change', onInput);

    /* Enter submits — the keyboard's "go" key should do the obvious thing. */
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (input.value.length === len && typeof opts.onComplete === 'function') {
          fired = true; lastFired = input.value;
          opts.onComplete(input.value);
        }
      }
    });

    /* ── WebOTP (Android Chrome) ───────────────────────────────────────────────
       Progressive enhancement. It only fires when the SMS body ends with the
       origin-bound line "@host #code" — Firebase's phone-auth template does NOT
       currently include it, so this is a no-op today and stays one until the SMS
       template changes. Wiring it now costs nothing (feature-detected, aborted on
       destroy) and means the day the template gains the suffix, one-tap works with
       no further client change. The keyboard-suggestion path above works regardless. */
    if ('OTPCredential' in global && global.isSecureContext) {
      try {
        ac = new AbortController();
        navigator.credentials.get({ otp: { transport: ['sms'] }, signal: ac.signal })
          .then(function (otp) {
            if (!otp || !otp.code) return;
            input.value = sanitize(otp.code);
            onInput();
          })
          .catch(function () { /* aborted, unsupported, or user dismissed — ignore */ });
      } catch (e) { /* no-op */ }
    }

    var api = {
      el: input,
      value: function () { return input.value; },
      focus: function () { try { input.focus(); } catch (e) {} return api; },
      clear: function () {
        input.value = '';
        input.classList.remove('is-full');
        input.setAttribute('aria-invalid', 'false');
        fired = false; lastFired = '';
        return api;
      },
      disabled: function (on) { input.disabled = !!on; return api; },
      error: function (on) {
        input.setAttribute('aria-invalid', on ? 'true' : 'false');
        /* Re-arm: a wrong code must be able to auto-submit again once corrected. */
        if (on) { fired = false; lastFired = ''; }
        return api;
      },
      destroy: function () {
        if (ac) { try { ac.abort(); } catch (e) {} ac = null; }
        return api;
      },
    };

    return api;
  }

  /* ── 6-box mode implementation ──────────────────────────────────────────────
     Six individual digit inputs. Each box handles its own input event and routes
     focus, paste, and backspace correctly.

     iOS AutoFill path: iOS fills the first box with the full 6-digit code despite
     maxLength=1 (AutoFill bypasses maxLength). The input handler detects value.length
     > 1 and distributes the digits across all boxes — one-tap autofill works.

     Android keyboard suggestions route to autocomplete="one-time-code" on the first
     box; the same distribute() path handles it.

     The public API is identical to the single-field API so callers need no changes.
  ─────────────────────────────────────────────────────────────────────────────── */
  function mountBoxes(host, opts, len, id) {
    var wrap = document.createElement('div');
    wrap.className  = 'sk-otp-boxes';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', opts.label || 'Verification code');

    var inputs = [];
    for (var i = 0; i < len; i++) {
      var box = document.createElement('input');
      box.type      = 'text';
      box.inputMode = 'numeric';
      box.setAttribute('pattern', '[0-9]*');
      box.maxLength = 1;
      box.className = 'sk-otp-box';
      box.setAttribute('aria-label', 'Digit ' + (i + 1) + ' of ' + len);
      /* Only the first box carries autocomplete="one-time-code": iOS/Android
         route the SMS suggestion to a SINGLE field; we distribute from there. */
      box.autocomplete = (i === 0) ? 'one-time-code' : 'off';
      if (i === 0) box.name = opts.name || 'one-time-code';
      box.setAttribute('autocapitalize', 'off');
      box.setAttribute('autocorrect', 'off');
      box.spellcheck    = false;
      box.enterKeyHint  = (i === len - 1) ? 'go' : 'next';
      /* Inline !important beats the global iOS-zoom guard (see single-field note). */
      box.style.setProperty('font-size', 'var(--sk-otp-box-fs, 22px)', 'important');
      inputs.push(box);
      wrap.appendChild(box);
    }

    var fired = false;
    var lastFired = '';

    function getValue() {
      return inputs.map(function(b) { return b.value; }).join('');
    }

    function distribute(str, startIdx) {
      /* Strip non-digits — handles "Your code is 899297", dashes, spaces, etc. */
      var digits = String(str || '').replace(/\D+/g, '').slice(0, len);
      var pos = startIdx || 0;
      for (var i = 0; i < digits.length && pos < len; i++, pos++) {
        inputs[pos].value = digits[i];
        inputs[pos].setAttribute('aria-invalid', 'false');
        inputs[pos].classList.remove('is-error');
      }
      /* Focus the first unfilled box, or the last box if all filled. */
      var focusIdx = pos < len ? pos : len - 1;
      try { inputs[focusIdx].focus(); } catch(e) {}
      maybeComplete();
    }

    function maybeComplete() {
      var v = getValue();
      if (v.length !== len) { fired = false; return; }
      if (fired && v === lastFired) return;
      fired = true;
      lastFired = v;
      inputs.forEach(function(b) { b.classList.add('is-full'); });
      if (typeof opts.onComplete === 'function') {
        setTimeout(function() { opts.onComplete(v); }, 120);
      }
    }

    inputs.forEach(function(box, idx) {
      box.addEventListener('input', function() {
        var v = box.value;
        /* iOS AutoFill fills the first box with the whole code despite maxLength. */
        if (v.length > 1) {
          box.value = '';
          distribute(v, idx === 0 ? 0 : idx);
          return;
        }
        var digit = v.replace(/\D/g, '');
        box.value = digit;
        if (digit) {
          box.setAttribute('aria-invalid', 'false');
          box.classList.remove('is-error');
          if (idx < len - 1) try { inputs[idx + 1].focus(); } catch(e) {}
          maybeComplete();
        }
      });

      box.addEventListener('keydown', function(e) {
        if (e.key === 'Backspace') {
          e.preventDefault();
          if (box.value) {
            box.value = '';
            fired = false;
          } else if (idx > 0) {
            inputs[idx - 1].value = '';
            fired = false;
            try { inputs[idx - 1].focus(); } catch(e) {}
          }
        } else if (e.key === 'ArrowLeft' && idx > 0) {
          e.preventDefault();
          try { inputs[idx - 1].focus(); } catch(e) {}
        } else if (e.key === 'ArrowRight' && idx < len - 1) {
          e.preventDefault();
          try { inputs[idx + 1].focus(); } catch(e) {}
        } else if (e.key === 'Enter' && idx === len - 1) {
          e.preventDefault();
          var v = getValue();
          if (v.length === len && typeof opts.onComplete === 'function') {
            fired = true; lastFired = v;
            opts.onComplete(v);
          }
        }
      });

      box.addEventListener('paste', function(e) {
        e.preventDefault();
        var pasted = (e.clipboardData || window.clipboardData || {}).getData('text');
        if (pasted) distribute(pasted, idx === 0 ? 0 : idx);
      });

      /* Select on focus: re-entering a digit is natural — tap the box, type. */
      box.addEventListener('focus', function() {
        try { box.select(); } catch(e) {}
      });
    });

    host.innerHTML = '';
    host.appendChild(wrap);

    var api = {
      el:    inputs[0] || null,
      value: function() { return getValue(); },
      focus: function() {
        var firstEmpty = null;
        for (var i = 0; i < inputs.length; i++) {
          if (!inputs[i].value) { firstEmpty = inputs[i]; break; }
        }
        try { (firstEmpty || inputs[0]).focus(); } catch(e) {}
        return api;
      },
      clear: function() {
        inputs.forEach(function(b) {
          b.value = '';
          b.classList.remove('is-full', 'is-error');
          b.setAttribute('aria-invalid', 'false');
        });
        fired = false; lastFired = '';
        return api;
      },
      disabled: function(on) {
        inputs.forEach(function(b) { b.disabled = !!on; });
        return api;
      },
      error: function(on) {
        inputs.forEach(function(b) {
          b.setAttribute('aria-invalid', on ? 'true' : 'false');
          b.classList.toggle('is-error', !!on);
        });
        if (on) { fired = false; lastFired = ''; }
        return api;
      },
      destroy: function() { return api; },
    };

    return api;
  }

  global.SokoniOtp = { mount: mount };
})(window);
