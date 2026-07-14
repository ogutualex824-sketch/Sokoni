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
    '.sk-otp{position:relative}',
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
    '@media (max-width:360px){.sk-otp-in{font-size:21px;letter-spacing:.3em;text-indent:.3em}}',
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

  global.SokoniOtp = { mount: mount };
})(window);
