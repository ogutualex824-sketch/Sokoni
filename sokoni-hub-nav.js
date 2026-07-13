/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI HUB NAVIGATION  —  sokoni-hub-nav.js

   Stops a tool page from becoming a navigation dead end, and makes its internal
   sections behave like real pages.

   ── What was actually wrong ───────────────────────────────────────────────────
   The Event Manager already HAS a working back link — sticky, 44px, and it does land
   on the Events Hub. The complaint is real, but the cause is not a missing button.

   Its eleven "pages" (Dashboard, Analytics, Check-ins, Attendees, Revenue, …) are not
   pages at all. They are sections of ONE document, switched by:

       function showSection(name, el) {
         ...remove .active from all... add .active to one...
       }

   No history entry. No hash. So:

     • The browser/device BACK gesture does not step back through them — it leaves the
       organizer entirely. On iOS, a swipe-back from Analytics throws you out of the
       tool. THAT is the dead end: not the absence of a button, but a back gesture that
       overshoots everything the user did.
     • A notification, QR code or shared link cannot open a section. Deep linking is
       impossible, so anyone arriving from outside lands on Dashboard regardless.
     • Reloading always drops you back to Dashboard.

   ── What this does ────────────────────────────────────────────────────────────
   Gives sections real history entries, so Back means "the previous section" — and,
   at the first section, "the hub". Restores hub state (scroll, filters, tabs, search)
   so returning is instant rather than a reload.

   Deliberately generic: any hub/tool pair can use it, not just Events.

   Usage — one call:

     SokoniHubNav.init({
       hub:      { url: '/event-hub.html', label: 'Events Hub' },
       sections: ['dashboard','events','create','orders','checkin','promo','analytics'],
       show:     (name) => showSection(name, document.querySelector('[data-sec="'+name+'"]')),
       home:     'dashboard',
     });
═════════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  if (global.SokoniHubNav) return;

  var doc = global.document;
  if (!doc) return;

  var CFG   = null;
  var KEY   = null;          /* sessionStorage key for the hub's state */
  var ready = false;

  /* ── Hub state ────────────────────────────────────────────────────────────────
     Saved by the HUB page before it is left, restored when it is returned to. Kept in
     sessionStorage, not localStorage: this is the state of one browsing session, and it
     should not still be sitting there tomorrow deciding what the user sees. */
  function stateKey(url) { return 'sk-hubstate:' + String(url).split('?')[0]; }

  function saveHubState(extra) {
    try {
      var sc = doc.scrollingElement || doc.documentElement;
      var main = doc.querySelector('#main, [data-scroll-root]');
      var state = {
        scroll: main ? main.scrollTop : sc.scrollTop,
        at:     Date.now(),
      };
      /* Filters / tabs / search — read from anything the page marks as restorable, so a
         hub does not have to enumerate its own controls. */
      var fields = {};
      doc.querySelectorAll('[data-hub-state]').forEach(function (el) {
        var id = el.getAttribute('data-hub-state') || el.id;
        if (!id) return;
        if (el.type === 'checkbox' || el.type === 'radio') fields[id] = !!el.checked;
        else if (el.value !== undefined)                   fields[id] = el.value;
        else                                               fields[id] = el.classList.contains('active');
      });
      state.fields = fields;
      sessionStorage.setItem(stateKey(location.pathname), JSON.stringify(state));
    } catch (e) { /* private mode — state restore is an enhancement, never a dependency */ }
  }

  function restoreHubState() {
    try {
      var raw = sessionStorage.getItem(stateKey(location.pathname));
      if (!raw) return false;
      var st = JSON.parse(raw);

      /* Stale state is worse than none: coming back to a two-hour-old filter you have
         forgotten setting looks like a bug. 30 minutes is one sitting. */
      if (!st || (Date.now() - (st.at || 0)) > 30 * 60 * 1000) return false;

      Object.keys(st.fields || {}).forEach(function (id) {
        var el = doc.querySelector('[data-hub-state="' + id + '"]') || doc.getElementById(id);
        if (!el) return;
        var v = st.fields[id];
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!v;
        else if (el.value !== undefined && typeof v === 'string') el.value = v;
        /* Let the page react — filters re-run, lists re-render. */
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
      });

      /* Scroll LAST, after the page has had a chance to re-render from those filters —
         restoring scroll before the content exists lands you at the top anyway. */
      var target = st.scroll || 0;
      if (target > 0) {
        var apply = function () {
          var main = doc.querySelector('#main, [data-scroll-root]');
          if (main) main.scrollTop = target;
          else (doc.scrollingElement || doc.documentElement).scrollTop = target;
        };
        requestAnimationFrame(function () { requestAnimationFrame(apply); });
        setTimeout(apply, 350);          /* after async lists land */
      }
      return true;
    } catch (e) { return false; }
  }

  /* ── Section routing ──────────────────────────────────────────────────────── */
  function sectionFromUrl() {
    var h = (location.hash || '').replace(/^#/, '');
    if (h && CFG.sections.indexOf(h) > -1) return h;
    var q = new URLSearchParams(location.search).get('section');
    if (q && CFG.sections.indexOf(q) > -1) return q;
    return null;
  }

  function go(name, push) {
    if (!CFG || CFG.sections.indexOf(name) === -1) return;
    CFG.show(name);
    CFG.current = name;

    if (push !== false) {
      /* A real history entry per section. This is the whole point: Back now steps back
         through the sections the user actually visited, instead of leaping out of the
         tool and discarding everything they did. */
      try { history.pushState({ skSection: name }, '', '#' + name); } catch (e) {}
    }
  }

  function onPop(e) {
    var st = e.state || {};

    /* The sentinel beneath the first section. Reaching it means the user pressed Back
       past everything they did in the tool. Send them to the hub. */
    if (st.skHubFloor) {
      if (CFG.hub && CFG.hub.url) location.replace(CFG.hub.url);
      else go(CFG.home, false);
      return;
    }

    var name = st.skSection || sectionFromUrl();
    if (name) { go(name, false); return; }

    if (CFG.hub && CFG.hub.url) location.replace(CFG.hub.url);
    else go(CFG.home, false);
  }

  /* ── The back control ─────────────────────────────────────────────────────── */
  function backControl() {
    if (!CFG.hub || !CFG.hub.url) return;
    if (doc.getElementById('sk-hub-back')) return;

    /* If the page ALREADY has a working link to the hub, leave it alone. A second back
       control sitting beside the first is clutter, not clarity — and the Event Manager's
       existing header link is sticky and 44px and works perfectly well. Adopt what is
       there; only add a control where none exists. */
    var hubPath = String(CFG.hub.url).split('?')[0].replace(/^\//, '');
    var existing = Array.prototype.filter.call(doc.querySelectorAll('a[href]'), function (a) {
      return a.getAttribute('href').indexOf(hubPath) > -1;
    })[0];
    if (existing) { existing.setAttribute('data-sk-hub-back', 'existing'); return; }

    var a = doc.createElement('a');
    a.id = 'sk-hub-back';
    a.href = CFG.hub.url;
    a.setAttribute('aria-label', 'Back to ' + CFG.hub.label);
    a.innerHTML = '<span aria-hidden="true">&#8592;</span> ' + CFG.hub.label;
    a.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:6px',
      'min-height:44px', 'padding:0 14px',        /* 44px: the iOS touch-target floor */
      'border-radius:999px',
      'background:rgba(113,255,0,.10)', 'border:1px solid rgba(113,255,0,.32)',
      'color:#71ff00', 'font-size:13px', 'font-weight:800',
      'text-decoration:none', 'white-space:nowrap',
      'transition:transform .12s ease,background .15s ease',
    ].join(';');
    a.addEventListener('touchstart', function () { a.style.transform = 'scale(.95)'; }, { passive: true });
    a.addEventListener('touchend',   function () { a.style.transform = ''; },           { passive: true });

    /* Placed in the page's own header if it has one, so it inherits that header's
       stickiness rather than introducing a second floating layer to collide with the
       Quick Actions bar, the chat FAB and the back-to-top button. */
    var slot = doc.querySelector('[data-hub-back-slot]') ||
               doc.querySelector('header .hdr-right, header .hdr-actions, header');
    if (slot) slot.insertBefore(a, slot.firstChild);
  }

  /* ── Public ───────────────────────────────────────────────────────────────── */
  function init(cfg) {
    if (ready) return;
    ready = true;

    CFG = {
      hub:      cfg.hub || null,
      sections: cfg.sections || [],
      show:     cfg.show || function () {},
      home:     cfg.home || (cfg.sections && cfg.sections[0]),
      current:  null,
    };

    backControl();

    /* Deep link: a notification, QR code or shared link may land directly on a section.
       Honour it — and lay a FLOOR beneath it first.

       Without the floor, Back from the first section is a real cross-document navigation,
       which a popstate handler cannot intercept: the user leaves the app entirely (to
       about:blank if they arrived from a notification, since there is nothing behind).
       That is the dead end, and no <a href> back button can fix it — the gesture never
       touches the button.

       So: replace the current entry with a FLOOR, then push the section on top. Back from
       the section now pops onto the floor, popstate fires, and we redirect to the hub.
       The tool is now impossible to fall out of backwards. */
    var initial = sectionFromUrl() || CFG.home;
    try {
      history.replaceState({ skHubFloor: true }, '', location.pathname + location.search);
      history.pushState({ skSection: initial }, '', '#' + initial);
    } catch (e) {}
    CFG.show(initial);
    CFG.current = initial;

    global.addEventListener('popstate', onPop);

    /* The hub saves its own state as the user leaves it. */
  }

  /* Called BY the hub page (not the tool) so returning is instant. */
  function hub(opts) {
    KEY = stateKey(location.pathname);
    var restored = restoreHubState();
    /* pagehide, not unload: unload does not fire reliably on iOS Safari, which is the
       one browser this most needs to work in. */
    global.addEventListener('pagehide', function () { saveHubState(); });
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'hidden') saveHubState();
    });
    return restored;
  }

  global.SokoniHubNav = {
    init: init,
    hub: hub,
    go: go,
    save: saveHubState,
    restore: restoreHubState,
  };

})(typeof window !== 'undefined' ? window : this);
