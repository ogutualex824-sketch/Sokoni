/* ================================================================
   SOKONI — Service Worker Registration + PWA + Push Notifications
   Include on every page: <script src="sw-register.js"></script>

   PUSH NOTIFICATION SETUP:
   1. Firebase Console → Project Settings → Cloud Messaging
   2. Generate VAPID key pair → copy the public key
   3. Paste it below ↓
================================================================ */

(function () {
  "use strict";

  /* ── Idempotency: shared-header.js now injects this script on pages that do
     not include it directly, so a page could load it twice. Running the whole
     registration/listener setup twice would double-bind controllerchange and
     re-run update checks. Bail if we've already initialised. ── */
  if (window.__sokoniSwRegisterInit) return;
  window.__sokoniSwRegisterInit = true;

  /* ── HTTPS check — service workers need a secure context ── */
  const _isSecure = location.protocol === "https:" ||
                    location.hostname === "localhost" ||
                    location.hostname === "127.0.0.1";
  /* Only skip SW registration (not the install prompt) on non-HTTPS */
  if (!_isSecure && "serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
  }

  /* ── ⚙️ VAPID KEY — paste yours here after generating in Firebase Console ── */
  const SOKONI_VAPID_KEY = "BMl0A7E14MzZgiRao7a8lhl0iRRV37jSwp26IvQGle38v3vAhZgNFNgqDObX8i_vD0Xrfw4wG-5ngbBMto7qEBg";
  /* ────────────────────────────────────────────────────────────────────────── */

  /* ══════════════════════════════════════════════════════
     0. BUILD-VERSION EVIDENCE — proves what the DEVICE is running vs. what's DEPLOYED.
        runningCache  = the active SW's cache name (what this device is actually serving)
        deployedCache = version.json fetched fresh from network (what's live right now)
        stale === true → the device is on an OLD build (SW hasn't swapped yet).
        Usage: const b = await window.sokoniBuildInfo();
  ══════════════════════════════════════════════════════ */
  window.sokoniBuildInfo = async function () {
    const info = { runningCache: null, deployedCache: null, deployedCommit: null, stale: null };
    try {
      const keys = await caches.keys();
      const k = keys.find(x => /^sokoni-.*-v\d+/.test(x)) || '';
      info.runningCache = (k.match(/v\d+/) || [null])[0];
    } catch (_) {}
    try {
      const v = await (await fetch('/version.json?cb=' + Date.now(), { cache: 'no-store' })).json();
      info.deployedCache  = (String(v.cacheVersion || '').match(/v\d+/) || [null])[0];
      info.deployedCommit = v.commitShort || null;
    } catch (_) {}
    if (info.runningCache && info.deployedCache) {
      info.stale = parseInt(info.runningCache.slice(1), 10) < parseInt(info.deployedCache.slice(1), 10);
    }
    return info;
  };

  /* ══════════════════════════════════════════════════════
     1. REGISTER SERVICE WORKER (HTTPS only)
  ══════════════════════════════════════════════════════ */
  let _swReg = null; /* stored so the Update button can reach the waiting worker */

  /* Apply update: tell waiting SW to skip waiting, controllerchange reloads once */
  let _userRequestedUpdate = false;
  window._sokoniApplyUpdate = function () {
    const toast = document.getElementById("swUpdateToast");
    if (toast) toast.remove();
    if (_swReg && _swReg.waiting) {
      _userRequestedUpdate = true;
      _swReg.waiting.postMessage({ type: "SKIP_WAITING" });
    } else {
      window.location.reload();
    }
  };

  /* ── One-tap update check ─────────────────────────────────────────
     Call window.sokoniCheckForUpdates(optionalBtn) from any page.
     Flow: force SW check → if new version found, auto-apply & reload
           otherwise show "Already up to date" and restore button.
  ──────────────────────────────────────────────────────────────────*/
  window.sokoniCheckForUpdates = async function (btn) {
    const origHTML = btn ? btn.innerHTML : null;
    const setBtn = (html, disabled) => { if (btn) { btn.innerHTML = html; btn.disabled = !!disabled; } };

    /* Hard reload if no SW support */
    if (!_swReg || !("serviceWorker" in navigator)) {
      window.location.reload(true);
      return;
    }

    setBtn("⏳ Checking…", true);

    /* If a waiting worker already exists — apply it immediately */
    if (_swReg.waiting) {
      setBtn("🔄 Updating…", true);
      _userRequestedUpdate = true;
      _swReg.waiting.postMessage({ type: "SKIP_WAITING" });
      return;
    }

    try {
      /* Force browser to fetch the SW file from network */
      await _swReg.update();
    } catch (e) {
      setBtn(origHTML, false);
      _showUpToDateToast("⚠️ Could not check — are you online?");
      return;
    }

    /* Re-check: update() may have resolved a waiting worker synchronously */
    if (_swReg.waiting) {
      setBtn("🔄 Updating…", true);
      _userRequestedUpdate = true;
      _swReg.waiting.postMessage({ type: "SKIP_WAITING" });
      return;
    }

    /* Wait up to 10 s for updatefound → installed */
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      setBtn(origHTML, false);
      _showUpToDateToast("✓ You're on the latest version");
    }, 10000);

    _swReg.addEventListener("updatefound", function onFound() {
      _swReg.removeEventListener("updatefound", onFound);
      const nw = _swReg.installing;
      if (!nw) return;
      setBtn("⬇️ Downloading…", true);
      nw.addEventListener("statechange", function () {
        if (nw.state === "installed" && navigator.serviceWorker.controller) {
          clearTimeout(timer);
          if (resolved) return;
          resolved = true;
          setBtn("🔄 Applying…", true);
          _userRequestedUpdate = true;
          _swReg.waiting && _swReg.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      });
    });
  };

  function _showUpToDateToast(msg) {
    const t = document.createElement("div");
    t.style.cssText = `position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#1e1e1e;border:1px solid rgba(113,255,0,0.3);color:#71ff00;padding:11px 20px;border-radius:12px;font-size:13px;font-weight:700;z-index:999999;white-space:nowrap;box-shadow:0 6px 24px rgba(0,0,0,0.5);pointer-events:none;`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .4s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 420); }, 3000);
  }

  if (_isSecure && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      /* Register main SW — absolute path + updateViaCache:none so the SW
         file is never served from HTTP cache, ensuring instant version pickup */
      navigator.serviceWorker
        .register("/service-worker.js", { scope: "/", updateViaCache: "none" })
        .then(reg => {
          _swReg = reg;
          console.log("[SOKONI SW] Registered:", reg.scope);

          /* Show update toast only when a waiting worker is fully installed */
          reg.addEventListener("updatefound", () => {
            const newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener("statechange", () => {
              if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
                _showUpdateToast();
              }
            });
          });

          /* If a waiting worker already exists on page load, show toast */
          if (reg.waiting && navigator.serviceWorker.controller) {
            setTimeout(_showUpdateToast, 2000);
          }

          /* ── FOREGROUND UPDATE CHECK ───────────────────────────────────────
             The browser only re-fetches service-worker.js on a navigation or its
             own ~24h timer. An installed PWA (or a long-lived tab) that is
             backgrounded while a new version ships would otherwise not notice
             until the next full navigation. So when the app returns to the
             foreground — tab focus, PWA resume — ask for a fresh SW check. If a
             newer version exists, updatefound → statechange → _showUpdateToast()
             surfaces the one-tap "Update available" prompt promptly.

             updateViaCache:'none' means this always hits the network for the SW
             file. Throttled to at most once a minute so rapid focus/blur flips
             (and the keyboard opening on mobile) never hammer the network. */
          let _lastUpdateCheck = Date.now();   /* registration itself just checked */
          const _foregroundUpdateCheck = () => {
            if (document.visibilityState !== "visible") return;
            const now = Date.now();
            if (now - _lastUpdateCheck < 60000) return;
            _lastUpdateCheck = now;
            if (_swReg) { try { _swReg.update(); } catch (_) {} }
          };
          document.addEventListener("visibilitychange", _foregroundUpdateCheck);
          window.addEventListener("focus", _foregroundUpdateCheck);
        })
        .catch(err => console.warn("[SOKONI SW] Registration failed:", err));

      /* FCM messaging SW — Firebase's getToken() in firebase.js handles push
         subscription using the main SW. We must NOT explicitly register
         firebase-messaging-sw.js at scope '/' because it would compete with
         service-worker.js for the same scope, causing spurious updatefound events,
         phantom "Update Available" toasts, and controllerchange→reload loops.
         Proactively unregister any stale FCM SW previously installed at root scope. */
      navigator.serviceWorker.getRegistrations().then(allRegs => {
        for (const r of allRegs) {
          const scriptURL = (r.active || r.waiting || r.installing)?.scriptURL || "";
          if (scriptURL.includes("firebase-messaging-sw.js") &&
              (r.scope === location.origin + "/" || r.scope === "/")) {
            r.unregister();
            console.log("[SOKONI SW] Removed stale FCM SW from root scope");
          }
        }
      }).catch(() => {});

      /* Reload when a NEW SW REPLACES an existing one — so the page HTML and
         inline scripts stay in sync with the active SW version. Without this,
         users run old page content under a new SW.

         FIRST-INSTALL EXCEPTION (the fix). A fresh visitor has no controller.
         When service-worker.js installs and clients.claim() takes control,
         controllerchange fires even though nothing was replaced — the page is
         already the current version. Reloading here was proven to cancel the
         first-load Firestore Listen channel and abandon the App Check token
         exchange, so anonymous visitors kept seeing demo data while the real
         catalogue read was interrupted every load. Runtime evidence: two
         navigations to the same URL on a fresh visit, App Check stuck pending,
         SokoniDB never finishing.

         So we reload only when a controller EXISTED at page load — a genuine
         update — and never on first acquisition. Captured now, before the new
         worker can claim the page.

         OAUTH EXCEPTION (unchanged). signInWithRedirect → Google → back is a
         multi-page navigation; a controllerchange mid-round-trip must not
         reload, or getRedirectResult() is abandoned. auth.js sets
         sokoniAuthRedirectPending for that window. */
      const _hadControllerAtLoad = !!navigator.serviceWorker.controller;
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!_hadControllerAtLoad) {
          console.info('[SOKONI SW] first controller acquired — no reload (page already current)');
          return;
        }
        try {
          if (sessionStorage.getItem('sokoniAuthRedirectPending')) {
            console.info('[SOKONI SW] controllerchange skipped — OAuth redirect in flight');
            return;
          }
        } catch (_) {}
        /* ── Page-level veto ──────────────────────────────────────────────
           A content page can be replaced under the reader without cost. A till
           cannot: reloading mid-sale discards the cart and the cashier starts
           over in front of a customer. That difference is real, but it is not
           this file's business to know what a sale is.

           So the page decides. window.AppLifecycle.canReload() defaults to
           true when absent, which is every page except the POS — the guard
           costs nothing where it does not apply, and no page has to opt in to
           keep working.

           A page that vetoes owns the reload: it must call
           AppLifecycle.applyPendingReload() once it is safe, or the update
           never lands. That is the correct trade — a stale POS is recoverable,
           a lost sale is not. */
        try {
          if (window.AppLifecycle && typeof window.AppLifecycle.canReload === 'function'
              && window.AppLifecycle.canReload() === false) {
            console.info('[SOKONI SW] reload deferred — page reports work in progress');
            window.__sokoniReloadPending = true;
            window.dispatchEvent(new CustomEvent('sokoni:reload-deferred'));
            return;
          }
        } catch (_) { /* a broken predicate must not block a legitimate update */ }

        /* ── ONLY reload for a USER-REQUESTED update ──────────────────────────
           This is the fix for the "old version loads, then reloads to the new one"
           flash. The SW calls skipWaiting() on install, so a freshly-deployed
           worker activates on its own and fires controllerchange in every open tab.
           Reloading on THAT — an update the user never asked for — is exactly the
           involuntary double-load being reported.

           Content freshness does not depend on this reload: HTML, CSS and JS are
           all network-first (see service-worker.js), so a returning visitor already
           gets the latest on load, and their next navigation is fully current under
           the new worker. The one-tap "Update available" toast lets anyone who wants
           it immediately force the swap — that path sets _userRequestedUpdate and
           gets the single expected reload below. Everyone else updates seamlessly on
           their next navigation, with no flash. */
        if (!_userRequestedUpdate) {
          console.info('[SOKONI SW] new worker active — no forced reload (applies on next navigation; tap Update to apply now)');
          return;
        }

        if (!refreshing) { refreshing = true; window.location.reload(); }
      });
    });
  }

  /* ══════════════════════════════════════════════════════
     2. NOTIFICATION PERMISSION + FCM TOKEN
  ══════════════════════════════════════════════════════ */

  async function _initPushNotifications() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "denied") return;
    if (localStorage.getItem("sokoniNotifDismissed")) return;

    /* Show our own permission prompt first (much better UX than raw browser prompt) */
    if (Notification.permission === "default") {
      await new Promise(r => setTimeout(r, 6000));
      _showNotificationPrompt();
      return; /* Will be called again after user accepts */
    }

    /* Permission already granted — set up everything */
    if (Notification.permission === "granted") {
      await _setupPushAfterPermission();
    }
  }

  async function _setupPushAfterPermission() {
    /* Register periodic sync if supported (Android Chrome) */
    try {
      const reg = await navigator.serviceWorker.ready;
      if ("periodicSync" in reg) {
        const status = await navigator.permissions.query({ name: "periodic-background-sync" });
        if (status.state === "granted") {
          await reg.periodicSync.register("sokoni-daily", { minInterval: 24 * 60 * 60 * 1000 });
          console.log("[SOKONI] Periodic sync registered — daily notifications active");
        }
      }
    } catch (e) {}

    /* Background sync as fallback */
    try {
      const reg = await navigator.serviceWorker.ready;
      if ("sync" in reg) {
        await reg.sync.register("sokoni-notify");
      }
    } catch (e) {}

    /* FCM token if VAPID key is set */
    if (SOKONI_VAPID_KEY !== "YOUR_VAPID_KEY_HERE") {
      try {
        const { sokoniRequestPushPermission, sokoniListenMessages } =
          await import("./firebase.js");
        const token = await sokoniRequestPushPermission(SOKONI_VAPID_KEY);
        if (token) {
          localStorage.setItem("sokoni_fcm_token", token);
          sokoniListenMessages(null);
        }
      } catch (e) {
        console.warn("[SOKONI Push] FCM init error:", e.message);
      }
    }
  }

  /* ── Notification permission prompt ── */
  function _showNotificationPrompt() {
    if (document.getElementById("sokoniNotifPrompt")) return;

    /* NEVER cover the privacy / cookie consent banner.
       Measured on a 375px viewport: this prompt (position:fixed, z-index 999997)
       rendered directly on top of #_sokoniPrivacyBanner, and elementFromPoint at
       the centre of the banner's "Privacy Policy" and "Cookie Policy" links
       returned this prompt instead of the links. They were not merely small —
       they were UNCLICKABLE. Obscuring a consent notice is a compliance problem,
       not a cosmetic one.

       Consent is legally required and must come first; a notification opt-in is
       not. So wait for the banner to be dismissed, then ask. */
    /* The same applies to the welcome modal: a screenshot on real Desktop Chrome
       showed this prompt rendered ON TOP of #welcomePopup, covering its
       "Maybe later" link. So gate on ANY blocking layer, not just the banner —
       otherwise we fix one collision and ship the next.

       NB: do NOT test offsetParent here. These are position:fixed, and
       offsetParent is ALWAYS null for a fixed element — that check silently
       reported "not visible" for a banner that was plainly on screen. */
    const BLOCKING = ["_sokoniPrivacyBanner", "welcomePopup"];
    const onScreen = id => {
      const e = document.getElementById(id);
      if (!e) return false;
      const cs = getComputedStyle(e);
      return e.getBoundingClientRect().height > 0 &&
             cs.visibility !== "hidden" && cs.display !== "none" &&
             parseFloat(cs.opacity) > 0.05;
    };
    if (BLOCKING.some(onScreen)) {
      const obs = new MutationObserver(() => {
        /* Wait for EVERY blocking layer to clear, not just the banner. Watching
             only the banner meant the prompt still fired while the welcome modal
             was open — precisely the collision being fixed here. */
          if (!BLOCKING.some(onScreen)) {
          obs.disconnect();
          setTimeout(_showNotificationPrompt, 800);   /* let the banner finish leaving */
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      return;
    }
    if (window.matchMedia("(display-mode: standalone)").matches) {
      Notification.requestPermission().then(perm => {
        if (perm === "granted") _setupPushAfterPermission();
      }).catch(() => {});
      return;
    }

    /* Inject keyframes once */
    if (!document.getElementById("_sokoniKF")) {
      const s = document.createElement("style");
      s.id = "_sokoniKF";
      s.textContent = `
        @keyframes _sokoniUp{from{opacity:0;transform:translateX(-50%) translateY(24px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
        @keyframes _sokoniInstallUp{from{opacity:0;transform:translateX(-50%) translateY(24px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
      `;
      document.head.appendChild(s);
    }

    const el = document.createElement("div");
    el.id = "sokoniNotifPrompt";
    el.style.cssText = [
      "position:fixed",
      "bottom:calc(76px + env(safe-area-inset-bottom,0px))",
      "left:50%",
      "transform:translateX(-50%)",
      "width:calc(100vw - 28px)",
      "max-width:390px",
      "background:rgba(8,8,8,0.95)",
      "border:1px solid rgba(113,255,0,0.3)",
      "border-radius:22px",
      "padding:18px 18px 18px",
      "box-shadow:0 16px 48px rgba(0,0,0,0.75)",
      "z-index:999997",
      "display:flex",
      "align-items:flex-start",
      "gap:14px",
      "font-family:'Segoe UI',system-ui,-apple-system,sans-serif",
      "animation:_sokoniUp .38s cubic-bezier(.34,1.56,.64,1) forwards",
      "-webkit-backdrop-filter:blur(20px)",
      "backdrop-filter:blur(20px)",
    ].join(";");

    el.innerHTML = `
      <div style="font-size:34px;flex-shrink:0;line-height:1;margin-top:2px;">🔔</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:14px;font-weight:900;color:#fff;margin-bottom:4px;letter-spacing:-.01em;">
          Stay in the loop
        </div>
        <div style="font-size:12px;color:rgba(255,255,255,0.48);margin-bottom:14px;line-height:1.55;">
          Get alerts for new orders, messages &amp; flash deals — even when SOKONI is closed.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button
            style="flex:1;min-width:130px;padding:12px 10px;background:linear-gradient(135deg,#71ff00,#4fc800);color:#000;font-weight:900;border:none;border-radius:12px;cursor:pointer;font-family:inherit;font-size:13px;letter-spacing:-.01em;box-shadow:0 4px 14px rgba(113,255,0,0.3);-webkit-tap-highlight-color:transparent;touch-action:manipulation;"
            onclick="(function(){var p=document.getElementById('sokoniNotifPrompt');if(p)p.remove();Notification.requestPermission().then(function(perm){if(perm==='granted'){window._sokoniSetupPush&&window._sokoniSetupPush();}});})()">
            🔔 Allow Notifications
          </button>
          <button
            style="padding:12px 16px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.55);border-radius:12px;cursor:pointer;font-family:inherit;font-size:12px;-webkit-tap-highlight-color:transparent;touch-action:manipulation;"
            onclick="(function(){var p=document.getElementById('sokoniNotifPrompt');if(p)p.remove();localStorage.setItem('sokoniNotifDismissed','permanent');})()">
            Later
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(el);
    setTimeout(() => { const p = document.getElementById("sokoniNotifPrompt"); if(p) p.remove(); }, 18000);
  }

  /* Init push after page is interactive */
  if (document.readyState === "complete" || document.readyState === "interactive") {
    _initPushNotifications();
  } else {
    window.addEventListener("DOMContentLoaded", _initPushNotifications);
  }

  /* ══════════════════════════════════════════════════════
     3. LOCAL PUSH NOTIFICATION TRIGGERS
     Fires browser notifications for key app events
     even without an FCM backend
  ══════════════════════════════════════════════════════ */

  function _showLocalNotification(title, body, icon, url) {
    if (Notification.permission !== "granted") return;
    const n = new Notification(title, {
      body,
      icon:   icon  || "/assets/logosokoni.png",
      badge:        "/assets/logosokoni.png",
      vibrate:      [200, 100, 200],
      tag:    url   || title,
    });
    if (url) n.onclick = () => { window.focus(); window.location.href = url; };
  }

  /* Listen to localStorage changes for real-time events */
  window.addEventListener("storage", e => {
    /* New order placed */
    if (e.key === "sokoniOrders" && e.newValue) {
      try {
        const orders = JSON.parse(e.newValue) || [];
        const latest = orders[0];
        if (latest && (Date.now() - latest.timestamp < 5000)) {
          _showLocalNotification(
            "✅ Order Confirmed!",
            `Order ${latest.id} · KES ${Number(latest.total).toLocaleString()} — processing now`,
            "/assets/sokoni logoo.jpeg",
            "/track.html"
          );
        }
      } catch (_) {}
    }

    /* New message received */
    if (e.key === "sokoniMessages" && e.newValue) {
      try {
        const msgs   = JSON.parse(e.newValue) || [];
        const unread = msgs.reduce((s, c) => s + (c.unread || 0), 0);
        if (unread > 0) {
          const latest = msgs.find(c => c.unread > 0);
          _showLocalNotification(
            "💬 New Message",
            `${latest?.sellerName || "Someone"}: new message on Sokoni`,
            "/assets/sokoni logoo.jpeg",
            "/messages.html"
          );
        }
      } catch (_) {}
    }

    /* Flash sale started */
    if (e.key === "sokoniFlashSales" && e.newValue) {
      try {
        const sales  = JSON.parse(e.newValue) || [];
        const active = sales.filter(s => s.endsAt > Date.now());
        if (active.length > 0) {
          _showLocalNotification(
            "⚡ Flash Sale Started!",
            `${active.length} product(s) on sale — grab them before they're gone!`,
            "/assets/sokoni logoo.jpeg",
            "/flashsale.html"
          );
        }
      } catch (_) {}
    }

    /* New offer received (seller) */
    if (e.key === "sokoniOffers" && e.newValue) {
      try {
        const offers = JSON.parse(e.newValue) || [];
        const latest = offers[0];
        if (latest && (Date.now() - latest.timestamp < 5000)) {
          _showLocalNotification(
            "🏷️ New Offer Received",
            `Offer of KES ${Number(latest.offerPrice).toLocaleString()} on "${latest.productName}"`,
            "/assets/sokoni logoo.jpeg",
            "/seller.html"
          );
        }
      } catch (_) {}
    }
  });

  /* Make local notif + push setup available globally */
  window.sokoniNotify = _showLocalNotification;
  window._sokoniSetupPush = _setupPushAfterPermission;

  /* ══════════════════════════════════════════════════════
     4. UPDATE AVAILABLE TOAST
  ══════════════════════════════════════════════════════ */
  function _showUpdateToast() {
    if (document.getElementById("swUpdateToast")) return;
    const toast = document.createElement("div");
    toast.id = "swUpdateToast";
    toast.style.cssText = `
      position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
      background:#1e1e1e;border:1px solid rgba(113,255,0,0.3);
      color:white;padding:12px 16px;border-radius:14px;font-size:13px;
      font-weight:700;font-family:inherit;z-index:999999;
      display:flex;align-items:center;gap:10px;flex-wrap:wrap;
      box-shadow:0 8px 32px rgba(0,0,0,0.5);
      animation:swToastIn .3s ease;
      width:max-content;max-width:calc(100vw - 28px);box-sizing:border-box;
    `;
    toast.innerHTML = `
      <span>🔄 New version of SOKONI available</span>
      <button onclick="window._sokoniApplyUpdate()" style="padding:6px 14px;background:rgba(113,255,0,0.15);border:1px solid rgba(113,255,0,0.3);color:#71ff00;border-radius:8px;font-weight:800;font-size:12px;cursor:pointer;font-family:inherit;">Update</button>
      <button onclick="sessionStorage.setItem('_skUpdateToastSeen','1');this.closest('#swUpdateToast').remove()" style="background:none;border:none;color:rgba(255,255,255,0.3);cursor:pointer;font-size:16px;line-height:1;padding:0;">✕</button>
    `;
    if (!document.getElementById("swToastStyle")) {
      const s = document.createElement("style");
      s.id = "swToastStyle";
      s.textContent = "@keyframes swToastIn{from{opacity:0;transform:translateX(-50%) translateY(20px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}";
      document.head.appendChild(s);
    }
    document.body.appendChild(toast);
  }

  /* ══════════════════════════════════════════════════════
     5. PWA INSTALL PROMPT
     Single source of truth — no competing handlers.
     Android: beforeinstallprompt → native dialog
     iOS:     Share sheet instructions
  ══════════════════════════════════════════════════════ */

  const _COOLDOWN = 24 * 60 * 60 * 1000; /* 1 day */
  const _INSTALL_VER = "v20"; /* bump this to reset dismiss state on all devices */
  /* Reset dismiss flag when app version changes */
  if (localStorage.getItem("sokoniInstallVer") !== _INSTALL_VER) {
    localStorage.removeItem("sokoniInstallDismissed");
    localStorage.setItem("sokoniInstallVer", _INSTALL_VER);
  }
  /* Store the event on window so ANY script can reach it */
  window._sokoniInstallEvent = null;

  const _isInstalled = () =>
    window.matchMedia("(display-mode:standalone)").matches ||
    window.navigator.standalone === true;

  const _wasDismissed = () => {
    const t = Number(localStorage.getItem("sokoniInstallDismissed") || 0);
    return t && (Date.now() - t) < _COOLDOWN;
  };

  function _dismissInstall() {
    const b = document.getElementById("swInstallBanner");
    if (b) {
      b.style.opacity = "0";
      b.style.transform = "translateX(-50%) translateY(30px)";
      b.style.transition = "opacity .25s, transform .25s";
      setTimeout(() => b.remove(), 260);
    }
    localStorage.setItem("sokoniInstallDismissed", Date.now().toString());
  }
  window._dismissInstall = _dismissInstall;

  /* ── THE install function — called by button onclick ── */
  window.sokoniInstall = function () {
    const evt = window._sokoniInstallEvent;
    if (!evt) return;
    /* prompt() MUST be called in a user-gesture stack */
    evt.prompt();
    evt.userChoice.then(choice => {
      window._sokoniInstallEvent = null;
      const b = document.getElementById("swInstallBanner");
      if (b) b.remove();
      if (choice.outcome === "accepted") {
        localStorage.setItem("sokoniInstallDismissed",
          (Date.now() + 999 * 24 * 60 * 60 * 1000).toString());
      }
    }).catch(() => {});
  };

  /* ── Capture event — single listener, no competition ── */
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    window._sokoniInstallEvent = e;
    /* Large banner disabled — index.html shows the compact #pwaPrompt instead */
  });

  /* ── Banner builder ── */
  function _showInstallBanner() {
    if (document.getElementById("swInstallBanner") || _isInstalled()) return;

    /* Inject animation CSS once */
    if (!document.getElementById("_skBannerCSS")) {
      const s = document.createElement("style");
      s.id = "_skBannerCSS";
      s.textContent = `@keyframes _skUp{from{opacity:0;transform:translateX(-50%) translateY(24px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`;
      document.head.appendChild(s);
    }

    const hasPrompt = !!window._sokoniInstallEvent;
    const isIOS     = /iphone|ipad|ipod/i.test(navigator.userAgent);

    const b = document.createElement("div");
    b.id = "swInstallBanner";
    Object.assign(b.style, {
      position:       "fixed",
      bottom:         "calc(80px + env(safe-area-inset-bottom,0px))",
      left:           "50%",
      transform:      "translateX(-50%)",
      width:          "calc(100vw - 20px)",
      maxWidth:       "420px",
      background:     "rgba(6,6,6,0.97)",
      border:         "1px solid rgba(113,255,0,0.4)",
      borderRadius:   "22px",
      boxShadow:      "0 20px 60px rgba(0,0,0,0.85)",
      backdropFilter: "blur(24px)",
      webkitBackdropFilter: "blur(24px)",
      zIndex:         "999998",
      fontFamily:     "'Segoe UI',system-ui,sans-serif",
      animation:      "_skUp .4s cubic-bezier(.34,1.56,.64,1) forwards",
      overflow:       "hidden",
    });

    b.innerHTML = `
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:12px;padding:14px 14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);">
        <img src="assets/sokoni-logo-dark.png" style="width:42px;height:42px;object-fit:contain;flex-shrink:0;" onerror="this.style.display='none'">
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:900;color:#fff;">Install SOKONI</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:1px;">Free · Fast · Works offline</div>
        </div>
        <button onclick="window._dismissInstall()" style="width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.55);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;-webkit-tap-highlight-color:transparent;touch-action:manipulation;">✕</button>
      </div>

      <!-- Body -->
      <div style="padding:14px;">
        ${hasPrompt ? `
        <!-- Android: one-tap install -->
        <button id="skInstallBtn"
          style="width:100%;padding:15px;background:linear-gradient(135deg,#71ff00,#4fc800);color:#000;border:none;border-radius:14px;font-weight:900;font-size:15px;cursor:pointer;font-family:inherit;letter-spacing:.01em;box-shadow:0 4px 20px rgba(113,255,0,0.4);-webkit-tap-highlight-color:transparent;touch-action:manipulation;margin-bottom:12px;">
          📲 Add to Home Screen
        </button>
        <p style="font-size:11px;color:rgba(255,255,255,0.35);text-align:center;margin-bottom:10px;">Tap above — your browser will ask to install</p>
        ` : isIOS ? `
        <!-- iOS: step-by-step -->
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.04);border-radius:12px;padding:10px 12px;">
            <span style="font-size:22px;flex-shrink:0;">⬆️</span>
            <div><div style="font-size:12px;font-weight:800;color:#fff;">1. Tap Share</div><div style="font-size:11px;color:rgba(255,255,255,0.45);">The box-with-arrow icon at the bottom of Safari</div></div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.04);border-radius:12px;padding:10px 12px;">
            <span style="font-size:22px;flex-shrink:0;">➕</span>
            <div><div style="font-size:12px;font-weight:800;color:#fff;">2. Add to Home Screen</div><div style="font-size:11px;color:rgba(255,255,255,0.45);">Scroll the Share sheet and tap this option</div></div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.04);border-radius:12px;padding:10px 12px;">
            <span style="font-size:22px;flex-shrink:0;">✅</span>
            <div><div style="font-size:12px;font-weight:800;color:#fff;">3. Tap Add</div><div style="font-size:11px;color:rgba(255,255,255,0.45);">Tap "Add" in the top-right corner — done!</div></div>
          </div>
        </div>
        ` : `
        <!-- Android without prompt: Chrome menu -->
        <p style="font-size:13px;color:rgba(255,255,255,0.6);margin-bottom:10px;line-height:1.6;">Open Chrome's menu (⋮) → tap <b style="color:#fff">Add to Home screen</b> or <b style="color:#fff">Install app</b>.</p>
        `}

        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
          <span style="padding:4px 10px;background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.2);border-radius:99px;font-size:10px;color:#71ff00;font-weight:700;">⚡ Faster</span>
          <span style="padding:4px 10px;background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.2);border-radius:99px;font-size:10px;color:#71ff00;font-weight:700;">📶 Offline</span>
          <span style="padding:4px 10px;background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.2);border-radius:99px;font-size:10px;color:#71ff00;font-weight:700;">🔔 Alerts</span>
          <span style="padding:4px 10px;background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.2);border-radius:99px;font-size:10px;color:#71ff00;font-weight:700;">📱 Full screen</span>
        </div>

        <button onclick="window._dismissInstall()" style="width:100%;padding:11px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.4);border-radius:12px;font-size:12px;cursor:pointer;font-family:inherit;-webkit-tap-highlight-color:transparent;touch-action:manipulation;">
          Maybe later
        </button>
      </div>
    `;

    document.body.appendChild(b);

    /* Wire the install button AFTER the element is in the DOM */
    if (hasPrompt) {
      const btn = document.getElementById("skInstallBtn");
      if (btn) {
        btn.addEventListener("click", function () {
          window.sokoniInstall();
        });
      }
    }

    /* Auto-dismiss after 40 s */
    setTimeout(() => { const el=document.getElementById("swInstallBanner"); if(el) el.remove(); }, 40000);
  }

  window.addEventListener("appinstalled", () => {
    window._sokoniInstallEvent = null;
    const b = document.getElementById("swInstallBanner");
    if (b) b.remove();

    /* In-app celebration toast */
    if (typeof showNotification === "function") {
      showNotification("🎉 SOKONI installed on your device!", "success");
    }

    /* Request notification permission immediately on install */
    if ("Notification" in window && Notification.permission === "default") {
      /* Small delay to let the install animation finish */
      setTimeout(() => {
        Notification.requestPermission().then(perm => {
          if (perm === "granted") {
            /* Fire welcome notification */
            navigator.serviceWorker.ready.then(reg => {
              reg.showNotification("🎉 SOKONI is installed!", {
                body:    "Welcome! Shop, sell & discover Kenya's best deals. Tap to open your marketplace.",
                icon:    "/assets/logosokoni.png",
                badge:   "/assets/logosokoni.png",
                vibrate: [200, 100, 200, 100, 200],
                tag:     "sokoni-install-welcome",
                data:    { url: "/index.html" },
                actions: [
                  { action: "shop",    title: "🛍️ Start Shopping" },
                  { action: "sell",    title: "🏪 Start Selling" },
                ],
                requireInteraction: true,
              });
            });
            _setupPushAfterPermission();
          }
        });
      }, 1500);
    } else if (Notification.permission === "granted") {
      /* Already have permission — just send the welcome notification */
      navigator.serviceWorker.ready.then(reg => {
        reg.showNotification("🎉 SOKONI is installed!", {
          body:    "Welcome! Shop, sell & discover Kenya's best deals.",
          icon:    "/assets/logosokoni.png",
          badge:   "/assets/logosokoni.png",
          vibrate: [200, 100, 200],
          tag:     "sokoni-install-welcome",
          data:    { url: "/index.html" },
          requireInteraction: false,
        });
      });
    }
  });

  /* ══════════════════════════════════════════════════════
     6. ONLINE / OFFLINE STATUS DOT
     NOTE: Banner logic lives exclusively in sokoni-ui.js _initOfflineBar().
     sw-register.js no longer manages any offline banner — removing the
     duplicate eliminated false positives during SW install/update cycles.
  ══════════════════════════════════════════════════════ */
  /* (dot is now updated by sokoni-ui.js _setBar() so state stays in sync) */

  /* ══════════════════════════════════════════════════════
     7. SW MESSAGE HANDLER
  ══════════════════════════════════════════════════════ */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", event => {
      if (event.data?.type === "SYNC_COMPLETE") {
        console.log("[SOKONI] Background sync complete");
      }
      if (event.data?.type === "PUSH_NOTIFICATION") {
        _showLocalNotification(
          event.data.title || "SOKONI",
          event.data.body  || "",
          event.data.icon,
          event.data.url
        );
      }
    });
  }

})();

/* ─────────────────────────────────────────────────────────────
   HYPER-SCALE BOOTSTRAP
   Lazily injects the universal infrastructure modules on every page
   that includes sw-register.js (104 pages). Scripts load after DOM
   is ready to avoid blocking first paint. Order is preserved so
   sokoni-logger is ready before sokoni-scale/cache use it.
───────────────────────────────────────────────────────────── */
(function _sokoniHyperscaleLoad() {
  const _mods = [
    "/sokoni-logger.js",
    "/sokoni-scale.js",
    "/sokoni-cache.js",
    "/sokoni-monitor.js",
    /* SW lifecycle telemetry. Loaded here rather than added to 109 page templates:
       one entry point, one place to remove it. Diagnostics only — it observes the
       worker and reports to /api/diag, and never registers or updates anything.
       sw-register.js above remains the sole owner of registration. */
    "/sokoni-sw-telemetry.js",
  ];

  function _inject(src) {
    const bare = src.replace(/^\//, "");
    if (document.querySelector('script[src="' + src + '"], script[src="' + bare + '"]')) return;
    const s   = document.createElement("script");
    s.src     = src;
    s.defer   = true;
    s.async   = false; // preserve load order within this group
    document.head.appendChild(s);
  }

  function _boot() {
    _mods.forEach(_inject);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _boot);
  } else {
    _boot();
  }
}());
