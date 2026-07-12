/* ================================================================
   sokoni-offline.js — Connectivity Detection v2.0

   The banner is driven by an ACTIVE PROBE, never by navigator.onLine.

   v2.0 — fixes "false offline banner with working internet, stuck":
   • navigator.onLine is NOT authoritative. Installed PWAs, iOS Safari and
     Android WebViews report it as `false` while the network is healthy.
     v1.x showed the banner directly from that flag and could only hide it
     when the flag flipped back — so on those platforms the banner appeared
     falsely and never cleared.
   • Now: the flag is only a HINT that schedules a probe.
       – Only a FAILED probe may SHOW the banner.
       – A SUCCESSFUL probe always HIDES it, immediately.
     Recovery therefore can never be blocked and the banner cannot stick.
   • Re-probes on online/offline, pageshow (bfcache/app-switch) and
     visibilitychange, so state self-heals after install, backgrounding,
     refresh and service-worker updates.
   • Same policy as sokoni-ui.js's #sk-offline-bar — the two detectors no
     longer contradict each other.
================================================================ */
(function () {
  'use strict';

  var _banner       = null;
  var _shown        = false;
  var _debounceTimer = null;

  /* ── Banner element ────────────────────────────────────── */
  function _ensureBanner() {
    if (_banner) return _banner;
    _banner = document.getElementById('sk-offline-banner');
    if (_banner) return _banner;

    _banner = document.createElement('div');
    _banner.id = 'sk-offline-banner';
    _banner.setAttribute('role', 'alert');
    _banner.setAttribute('aria-live', 'polite');
    _banner.textContent = '📡 No internet connection — some features may not work.';

    /* Inline critical styles so the banner works before any stylesheet loads */
    Object.assign(_banner.style, {
      position:        'fixed',
      top:             '64px',   /* sits just below the 64px top nav */
      left:            '0',
      right:           '0',
      zIndex:          '100003',
      padding:         '10px 16px',
      background:      'rgba(220,38,38,0.96)',
      color:           '#fff',
      fontSize:        '13px',
      fontWeight:      '700',
      textAlign:       'center',
      fontFamily:      '\'Segoe UI\', system-ui, sans-serif',
      backdropFilter:  'blur(12px)',
      borderBottom:    '1px solid rgba(220,38,38,0.4)',
      transform:       'translateY(-100%)',
      transition:      'transform 0.25s cubic-bezier(0.34,1.1,0.64,1)',
      willChange:      'transform',
    });

    document.body.appendChild(_banner);
    return _banner;
  }

  function _show() {
    /* Defer to sokoni-ui.js's richer #sk-offline-bar where it is present
       (index, etims, hub-dashboard) — avoids two stacked offline banners. */
    if (document.getElementById('sk-offline-bar')) return;
    if (_shown) return;
    _shown = true;
    var b = _ensureBanner();
    /* Force reflow so the CSS transition plays from translateY(-100%) → 0 */
    requestAnimationFrame(function () {
      b.style.transform = 'translateY(0)';
    });
  }

  function _hide() {
    if (!_shown) return;
    _shown = false;
    if (_banner) _banner.style.transform = 'translateY(-100%)';
  }

  /* ── Active connectivity probe — THE SOURCE OF TRUTH ────────────────────
     `navigator.onLine` is NOT authoritative and must never gate the banner on
     its own. Installed PWAs, iOS Safari and Android WebViews are known to report
     `navigator.onLine === false` while the network is perfectly healthy. This
     module previously treated the flag as authoritative and showed the banner
     from it directly, so on those platforms the banner appeared with working
     internet and could never be hidden again (nothing but the flag could clear
     it) — the "false offline, stuck banner" defect.

     Policy (identical to sokoni-ui.js, so the two detectors can no longer
     contradict each other):
       • The flag is a HINT that triggers a probe. It never shows the banner.
       • Only a FAILED probe may show the banner.
       • A SUCCESSFUL probe always hides it, immediately — recovery can never
         be blocked, so the banner cannot get stuck.

     Signal: no-cors GET https://www.gstatic.com/generate_204. Cross-origin and
     never cached by our service worker, so it fails iff the network is truly
     down. An own-origin URL would be served from the SW cache while offline and
     would falsely report "online".                                            */
  function _probe() {
    var ctrl;
    try { ctrl = new AbortController(); } catch (_) { ctrl = null; }
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 4000);

    return fetch('https://www.gstatic.com/generate_204', {
      mode:   'no-cors',
      cache:  'no-store',
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then(function () { clearTimeout(timer); return true; })   /* reached the network */
      .catch(function () {
        clearTimeout(timer);
        /* gstatic unreachable. If the browser still reports a network, assume the
           probe was blocked (firewall, extension, DNS) rather than declaring the
           user offline — a blocked probe must not produce a false banner. */
        return navigator.onLine === true;
      });
  }

  /* Re-evaluate true connectivity and drive the banner from the RESULT. */
  function _sync() {
    return _probe().then(function (online) {
      if (online) _hide(); else _show();
      return online;
    });
  }

  /* Public API (window.SokoniOffline.check) — same probe-confirmed policy. */
  function _check() { return _sync(); }

  /* ── Network event listeners ───────────────────────────── */
  window.addEventListener('offline', function () {
    /* The flag only schedules a probe. Debounced 1 s because Android/iOS fire
       `offline` during Wi-Fi handoffs that recover on their own. The probe —
       not the flag — decides whether the banner appears. */
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(_sync, 1000);
  });

  window.addEventListener('online', function () {
    /* Network restored — hide immediately, then confirm in the background.
       Hiding is never blocked on the probe, so recovery is guaranteed. */
    clearTimeout(_debounceTimer);
    _hide();
    _sync();
  });

  /* Re-check whenever the page is restored or refocused. Devices that sleep
     offline and wake online frequently never fire `online`; without this the
     banner stayed stranded after app-install, backgrounding, refresh, or a
     service-worker update. */
  window.addEventListener('pageshow', function () { _sync(); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) _sync();
  });

  /* Initial state: never show from the flag alone. Probe first; the banner
     appears only if the probe actually fails. */
  _sync();

  /* hide is exposed so sokoni-ui.js can cross-clear this banner when its
     own probe confirms connectivity — avoids double-banner race conditions. */
  window.SokoniOffline = { check: _check, sync: _sync, probe: _probe, hide: _hide };
}());
