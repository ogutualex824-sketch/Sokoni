/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Async section loader

   THE PROBLEM THIS EXISTS TO PREVENT
   Four separate blank-UI defects were traced this session, and all four shared
   one shape: an async data load whose FAILURE path never rendered anything.

     payment engine     guard returned before the engine loaded
     recommendations    promise chain had no .catch at all
     vehicle hub        onSnapshot error handler only console.warn'd, so the
                        renderer never ran and the list stayed as shipped: empty
     sign-out           catch swallowed the exception entirely

   In every case the user saw a blank region and we saw nothing. The section had
   four possible states in theory — loading, success, empty, error — and a fifth
   in practice: nothing happened.

   This module removes that fifth state by construction. A section loaded through
   loadSection() ALWAYS ends in a rendered state, because the error path renders
   too.

   IT IS NOT A WRAPPER AROUND EVERY try/catch. A defensive
   JSON.parse(localStorage) with a default is correct and needs nothing — the
   variable already falls back and the UI still draws. This is specifically for
   ASYNC DATA LOADS THAT PAINT A SECTION.
   ══════════════════════════════════════════════════════════════════════════ */
window.SokoniAsync = (() => {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* Errors a retry might actually fix, versus ones where retrying is theatre.
     A missing index or a permission denial will fail identically next time —
     offering "Try again" there teaches users the button is a lie. */
  const RECOVERABLE = /unavailable|deadline-exceeded|network|aborted|internal|timeout/i;
  function isRecoverable(code, message) {
    const s = String(code || '') + ' ' + String(message || '');
    if (/permission-denied|unauthenticated|failed-precondition|not-found|invalid-argument/i.test(s)) return false;
    return RECOVERABLE.test(s) || !code;
  }

  /* Structured diagnostic. Single call site, so a component cannot invent its
     own log shape, and reports reach errorLog via logClientDiagnostic where it
     is available (see functions/client-diagnostics.js). */
  function report(component, operation, err, extra) {
    const code = (err && (err.code || err.name)) || 'unknown';
    const message = (err && err.message) || String(err || 'unknown error');
    const recoverable = isRecoverable(code, message);

    console.error('[' + component + '] ' + operation + ' failed', {
      component, operation, code, message, recoverable, ...(extra || {}),
    });

    /* Fire-and-forget. Telemetry must never add a second failure on top of the
       first one the user is already experiencing. */
    try {
      if (window.firebaseApp) {
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js')
          .then((m) => m.httpsCallable(m.getFunctions(window.firebaseApp, 'us-central1'), 'logClientDiagnostic')({
            severity: recoverable ? 'warn' : 'error',
            code, message, surface: component,
            appVersion: 'async-1.0', userAgent: navigator.userAgent,
            viewport: innerWidth + 'x' + innerHeight, online: navigator.onLine,
            url: location.pathname,
            context: { operation, recoverable, ...(extra || {}) },
          })).catch(() => {});
      }
    } catch (_) {}

    return { code, message, recoverable };
  }

  const STYLE = 'padding:28px 16px;text-align:center;color:rgba(255,255,255,.45);font-size:13px;line-height:1.6;';

  function skeleton(label) {
    return '<div style="' + STYLE + '">⟳ ' + esc(label || 'Loading…') + '</div>';
  }

  function emptyView(msg) {
    return '<div style="' + STYLE + '">' + esc(msg || 'Nothing here yet.') + '</div>';
  }

  function errorView(msg, recoverable, retryAttr) {
    return '<div style="' + STYLE + '">' + esc(msg) +
      (recoverable && retryAttr
        ? '<br><button type="button" ' + retryAttr + ' style="margin-top:10px;padding:9px 18px;border-radius:9px;' +
          'border:1px solid rgba(113,255,0,.3);background:rgba(113,255,0,.12);color:#71ff00;' +
          'font-weight:700;font-size:12px;font-family:inherit;cursor:pointer;min-height:36px;">Try again</button>'
        : '') +
      '</div>';
  }

  /* ── loadSection ──────────────────────────────────────────────────────────
     el        element or id to paint
     load()    async, returns the data
     render(d) paints the success state; returns falsy to fall through to empty
     opts      { component, operation, empty, error, loading, isEmpty }

     Guarantees: the element is never left untouched. Every path — success,
     empty, error, and an exception thrown BY the renderer — ends in a paint. */
  async function loadSection(el, load, render, opts = {}) {
    const node = typeof el === 'string' ? document.getElementById(el) : el;
    if (!node) {
      console.warn('[SokoniAsync] target not found:', el);
      return { ok: false, reason: 'no-target' };
    }
    const component = opts.component || node.id || 'section';
    const operation = opts.operation || 'load';

    node.innerHTML = skeleton(opts.loading);

    let data;
    try {
      data = await load();
    } catch (err) {
      const d = report(component, operation, err);
      node.innerHTML = errorView(
        opts.error || (d.recoverable ? 'Could not load right now.' : 'This content is unavailable.'),
        d.recoverable, opts.retryAttr);
      return { ok: false, reason: 'load-failed', code: d.code };
    }

    const isEmpty = opts.isEmpty ? opts.isEmpty(data)
                  : (data == null || (Array.isArray(data) && data.length === 0));
    if (isEmpty) {
      node.innerHTML = emptyView(opts.empty);
      return { ok: true, empty: true };
    }

    /* A renderer that throws would leave a half-painted section, which looks
       identical to the bug this module exists to prevent. */
    try {
      const out = render(data, node);
      if (out === false) { node.innerHTML = emptyView(opts.empty); return { ok: true, empty: true }; }
    } catch (err) {
      const d = report(component, operation + ':render', err);
      node.innerHTML = errorView(opts.error || 'Could not display this content.', false, null);
      return { ok: false, reason: 'render-failed', code: d.code };
    }
    return { ok: true, empty: false };
  }

  return { loadSection, report, isRecoverable, views: { skeleton, emptyView, errorView } };
})();
