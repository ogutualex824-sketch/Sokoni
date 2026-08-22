/* ════════════════════════════════════════════════════════════════════════════
   SOKONI — mobile drawer / overlay diagnostic   (opt-in, ?diag=menu)

   WHY THIS EXISTS
   A controlled run at 390x844 could not reproduce the reported black layer on
   the product page: after load the top element at the viewport centre is a
   link, the document scrolls, and neither body nor html carries
   overflow:hidden. So the question is not "which layer should we restyle" —
   it is "does a full-viewport layer end up open on the device, and WHO opened
   it". Changing a z-index without that answer masks a cause instead of
   removing it.

   THREE TARGETS, NOT ONE — and the third is the reason this file changed
   shape. sokoni-ui-extras.js injectMobileMenu() builds a pair: the drawer
   #mobileMenu AND a full-viewport #menuOverlay. But measuring the product page
   turned up a third full-viewport layer that was never a suspect:

     #_sokoniPrivacyBanner   position:fixed   390x844 (100% of the viewport)
                             background rgba(0,0,0,0.66)   z-index 300001
                             pointer-events:auto

   On a profile that has not answered consent yet, THAT is the black layer over
   the product page — the viewport centre resolves to a link reading "Cookie
   Policy", inside the scrim. It dismisses correctly and the choice persists,
   so it is not itself a defect; it is simply the first thing to rule out.

   A drawer-only version of this file reported "layers parked away (expected)"
   while that scrim covered the page. An instrument that exonerates the menu
   system without naming what is actually on top is worse than no instrument,
   so all three are watched and the verdict names whichever is covering.

   BOTH ARE BUILT IN JAVASCRIPT, so neither exists when this file first runs.
   Observers therefore attach LAZILY, as each element appears — attaching once
   at DOMContentLoaded would depend on which listener registered first, and a
   silently-unattached observer reports an empty change log that looks exactly
   like "nothing happened".

   WHAT IT REPORTS
     · each layer's live display / visibility / opacity / transform /
       pointer-events / z-index / background
     · its rect against the viewport — the difference between SIZED and
       COVERING, which is what stops an innocent element being blamed
     · what elementFromPoint returns at the centre, the only honest test of
       interception
     · the state AT ARRIVAL, held separately — a layer already open when the
       page loads is a different defect from one a tap opens
     · every attribute change, with the LAST TAPPED ELEMENT at that moment,
       which is what identifies the opener
     · whether body or html is left scroll-locked

   COST WHEN OFF: never fetched. product.html loads it only when asked.

   It observes and prints. It changes no product state, styles nothing, and
   removes nothing.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* Consent scrim first — it is the likeliest black layer and the cheapest to
     rule out. Then the overlay, so a covering overlay is named before the
     drawer it belongs to. */
  var TARGETS = ['#_sokoniPrivacyBanner', '#menuOverlay', '#mobileMenu'];

  var log = [];
  var lastTap = null;
  var observed = {};   /* selector -> true once its observer is attached */
  var arrival = {};    /* selector -> the state the first time it was seen */

  /* Record what was touched, so a layer that opens can be attributed to a tap
     rather than guessed at. Capture phase, so it is still seen if a handler
     stops propagation. */
  ['pointerdown', 'touchstart', 'click'].forEach(function (evt) {
    document.addEventListener(evt, function (e) {
      var t = e.target;
      if (!t || !t.tagName) return;
      lastTap = {
        type: evt,
        tag: t.tagName.toLowerCase(),
        id: t.id || null,
        cls: String(t.className || '').slice(0, 48),
        text: String(t.textContent || '').trim().slice(0, 28)
      };
    }, true);
  });

  function stamp() { return new Date().toLocaleTimeString(); }

  function state(sel) {
    var el = document.querySelector(sel);
    if (!el) return { present: false };
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    /* SIZED is not COVERING. An off-screen drawer keeps its width and height,
       so reading the rect alone is how an innocent element gets blamed. */
    var onScreen = r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh;
    var centre = document.elementFromPoint(vw / 2, vh / 2);
    return {
      present: true,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      transform: cs.transform === 'none' ? 'none' : cs.transform.slice(0, 40),
      pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
      background: cs.backgroundColor,
      rect: {
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height)
      },
      onScreen: onScreen,
      coversCentre: !!(centre && (centre === el || el.contains(centre))),
      classes: String(el.className || '')
    };
  }

  function centreInfo() {
    var c = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    if (!c) return 'nothing (the centre may be covered by a layer outside the document)';
    var cls = String(c.className || '').trim();
    return c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') +
      (cls ? '.' + cls.split(/\s+/).join('.').slice(0, 40) : '');
  }

  /* Attach when the element appears, not when the page loads. */
  function attach(sel) {
    if (observed[sel]) return;
    if (!document.querySelector(sel)) return;
    var el = document.querySelector(sel);
    observed[sel] = true;
    arrival[sel] = state(sel);
    log.push(stamp() + '  ' + sel + ' APPEARED  classes="' + arrival[sel].classes +
      '"  covering=' + arrival[sel].coversCentre);
    new MutationObserver(function (muts) {
      muts.forEach(function (mu) {
        var s = state(sel);
        log.push(stamp() + '  ' + sel + '  ' + mu.attributeName +
          ' -> covering=' + s.coversCentre + ' classes="' + s.classes +
          '"  | last tap: ' + (lastTap ? JSON.stringify(lastTap) : 'none'));
      });
      render();
    }).observe(el, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
    });
  }

  function render() {
    TARGETS.forEach(attach);

    var box = document.getElementById('sk-menu-diag');
    if (!box) {
      box = document.createElement('div');
      box.id = 'sk-menu-diag';
      /* Above the drawer itself (9999998), or the readout would be hidden by
         the very thing it is reporting on.

         pointer-events:none is NOT cosmetic — it is what keeps the instrument
         from corrupting its own measurement. elementFromPoint skips
         pointer-events:none elements, so the panel can never be returned as
         "the thing under the centre", and it can never swallow the tap on the
         hamburger it is here to observe. The 40vh cap keeps it clear of the
         centre line on a 390x844 phone as well; both together, because either
         alone would make the readout a suspect. */
      box.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483646;' +
        'pointer-events:none;' +
        'background:#001018;color:#7ef;font:11px/1.4 ui-monospace,Menlo,monospace;' +
        'padding:8px 10px;max-height:40vh;overflow:hidden;border-bottom:2px solid #0af;' +
        'white-space:pre-wrap;word-break:break-word';
      document.documentElement.appendChild(box);
    }

    var now = {};
    TARGETS.forEach(function (s) { now[s] = state(s); });

    var covering = TARGETS.filter(function (s) { return now[s].present && now[s].coversCentre; });
    var showing = TARGETS.filter(function (s) { return now[s].present && now[s].onScreen && !now[s].coversCentre; });
    var anyPresent = TARGETS.some(function (s) { return now[s].present; });

    var verdict;
    if (covering.length) verdict = '*** COVERING THE PAGE: ' + covering.join(' + ') + ' ***';
    else if (showing.length) verdict = showing.join(' + ') + ' on-screen but NOT covering the centre';
    else if (anyPresent) verdict = 'layers present and parked away (expected)';
    else verdict = 'neither layer exists on this page yet';

    /* A layer already open on arrival is a DIFFERENT defect from one a tap
       opens, so the arrival state is kept rather than overwritten. */
    var arrivedOpen = TARGETS.filter(function (s) { return arrival[s] && arrival[s].coversCentre; });

    box.textContent =
      'SOKONI drawer / overlay diagnostic   ' + stamp() + '\n' +
      verdict + '\n' +
      'under viewport centre: ' + centreInfo() + '\n' +
      'scroll lock: body=' + getComputedStyle(document.body).overflow +
        '  html=' + getComputedStyle(document.documentElement).overflow + '\n' +
      'covering ON ARRIVAL: ' +
        (arrivedOpen.length ? arrivedOpen.join(' + ') + '   <-- survived a navigation' : 'none') + '\n' +
      JSON.stringify(now, null, 1) + '\n' +
      '--- changes (newest last) ---\n' +
      (log.length ? log.slice(-10).join('\n') : '(none yet)');
  }

  function start() { render(); setInterval(render, 700); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}());
