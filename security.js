/**
 * SOKONI SECURITY MODULE
 * Provides XSS prevention, input sanitisation, payment validation,
 * and Content Security Policy for all pages.
 *
 * Include FIRST in <head> before any other script on every page.
 */

/* ── Auto-inject SokoniSync engine on every page ── */
(function () {
  /* data-minimal="true" on <html> skips heavy wiring scripts (used by POS, admin tools) */
  if (document.documentElement.dataset.minimal === 'true') return;

  var base = (document.currentScript && document.currentScript.src)
    ? document.currentScript.src.replace(/security\.js.*$/, '')
    : '';
  if (!window.SokoniSync && !document.querySelector('script[src*="sokoni-sync"]')) {
    var s = document.createElement('script');
    s.src = base + 'sokoni-sync.js';
    document.head.appendChild(s);
  }
  if (!window.HubWiring && !document.querySelector('script[src*="hub-wiring"]')) {
    var h = document.createElement('script');
    h.src = base + 'hub-wiring.js';
    document.head.appendChild(h);
  }
  if (!window.SellerWiring && !document.querySelector('script[src*="seller-wiring"]')) {
    var sw = document.createElement('script');
    sw.src = base + 'seller-wiring.js';
    document.head.appendChild(sw);
  }
  if (!window.ProviderWiring && !document.querySelector('script[src*="provider-wiring"]')) {
    var pw = document.createElement('script');
    pw.src = base + 'provider-wiring.js';
    document.head.appendChild(pw);
  }
  if (!window.RealtimeWiring && !document.querySelector('script[src*="realtime"]')) {
    var rt = document.createElement('script');
    rt.src = base + 'realtime.js';
    document.head.appendChild(rt);
  }
  /* Company identity single-source-of-truth (window.SOKONI_COMPANY) — used by
     client-rendered receipts/invoices/footers so literals aren't duplicated. */
  if (!window.SOKONI_COMPANY && !document.querySelector('script[src*="sokoni-company"]')) {
    var co = document.createElement('script');
    co.src = base + 'sokoni-company.js';
    document.head.appendChild(co);
  }
  /* P1-9 (Phase 4 audit): load DOMPurify so SokoniSecurity.safeHTML() sanitizes with a
     real, spec-aware library instead of the bypassable regex fallback. Deferred + from
     cdnjs (allowed by CSP script-src). safeHTML falls back to regex until this loads. */
  if (!window.DOMPurify && !document.querySelector('script[src*="dompurify"],script[src*="purify.min"]')) {
    var dp = document.createElement('script');
    dp.src = 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.9/purify.min.js';
    dp.defer = true;
    dp.crossOrigin = 'anonymous';
    document.head.appendChild(dp);
  }
}());

const SokoniSecurity = (() => {

  /* ════════════════════════════════════════════════════════
     1. CONTENT SECURITY POLICY — served as an HTTP HEADER, not injected here.

     This function used to inject a SECOND CSP as a <meta> tag, alongside the header that
     firebase.json already sends on every route ("source": "**").

     When a page carries two policies the browser enforces BOTH — the effective policy is
     their INTERSECTION. So the meta tag could never loosen anything; it could only quietly
     make the real policy stricter than intended. And it had drifted:

       directive     header (firebase.json)                 meta (here)        effective
       frame-src     … https://auth.mysokoni.co.ke          MISSING            BLOCKED
       connect-src   … https://payment.intasend.com         MISSING            BLOCKED
       form-action   'self' https://payment.intasend.com    'self'             BLOCKED

     The frame-src gap is the one that broke sign-in. Firebase Auth loads a helper IFRAME on
     the configured authDomain (auth.mysokoni.co.ke) to complete popup/redirect OAuth and to
     restore the session. Blocking that frame produced, in production:

       Framing 'https://auth.mysokoni.co.ke/' violates the following Content Security Policy
       directive: "frame-src 'self' https://www.google.com …"

     Email/password sign-in survived (it is a plain XHR to identitytoolkit), which is exactly
     why this looked like an intermittent, hard-to-pin failure rather than a broken policy.

     The header is the single source of truth. It is strictly better than a meta tag: it
     cannot be tampered with from the DOM, it applies to every response including ones this
     script never runs on, and directives like frame-ancestors and report-uri are IGNORED in
     a meta tag anyway. A second copy could only ever drift from it again. */
  function injectCSP(){
    /* Intentionally a no-op. See the note above: firebase.json serves the CSP header on
       "**". Do NOT reintroduce a meta CSP — a duplicate policy is intersected with the
       header and silently removes origins the platform depends on. */
  }

  /* ════════════════════════════════════════════════════════
     2. XSS PREVENTION
     Always use these helpers instead of raw innerHTML.
  ════════════════════════════════════════════════════════ */

  /**
   * Escapes a string for safe HTML insertion.
   * Use: element.innerHTML = escapeHTML(userInput)
   */
  function escapeHTML(str){
    if(str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g,  "&amp;")
      .replace(/</g,  "&lt;")
      .replace(/>/g,  "&gt;")
      .replace(/"/g,  "&quot;")
      .replace(/'/g,  "&#x27;")
      .replace(/\//g, "&#x2F;")
      .replace(/`/g,  "&#x60;");
  }

  /**
   * Safe text setter — always use textContent, never innerHTML for user data.
   */
  function safeText(element, text){
    if(!element) return;
    element.textContent = text ?? "";
  }

  /**
   * Safe innerHTML sanitizer.
   * P1-9 (Phase 4 audit): prefer DOMPurify (a real, spec-aware sanitizer loaded
   * globally below). The previous regex approach is bypassable and kept only as a
   * fallback for the brief window before DOMPurify finishes loading. Every existing
   * caller of safeHTML() is upgraded automatically — no call-site changes needed.
   */
  function safeHTML(str){
    if(str === null || str === undefined || str === "") return "";
    if (typeof window !== "undefined" && window.DOMPurify && window.DOMPurify.sanitize) {
      return window.DOMPurify.sanitize(String(str), {
        ALLOWED_TAGS: ["b","i","em","strong","a","p","br","ul","ol","li","span","div",
                       "h1","h2","h3","h4","h5","h6","blockquote","code","pre","img","hr","small"],
        ALLOWED_ATTR: ["href","title","target","rel","src","alt","class"],
        FORBID_ATTR:  ["style","onerror","onload"],
        ALLOW_DATA_ATTR: false,
      });
    }
    /* Fallback (pre-DOMPurify): regex strip — bypassable, best-effort only. */
    return String(str)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/on\w+\s*=\s*["'][^"']*["']/gi, "")
      .replace(/on\w+\s*=\s*\S+/gi, "")
      .replace(/javascript\s*:/gi, "")
      .replace(/data\s*:/gi, "");
  }

  /* ════════════════════════════════════════════════════════
     3. INPUT SANITISATION
  ════════════════════════════════════════════════════════ */

  /**
   * Strip dangerous characters from a plain text input.
   * Use on all text fields before storing or displaying.
   */
  function sanitize(str){
    if(!str) return "";
    return String(str)
      .trim()
      .replace(/<[^>]*>/g, "")        // strip HTML tags
      .replace(/[<>"'`\\]/g, "")      // strip dangerous chars
      .substring(0, 2000);            // max length guard
  }

  /**
   * Sanitize an object's string values recursively.
   * Use before saving any user-submitted object to localStorage or Firestore.
   */
  function sanitizeObject(obj, maxDepth = 3){
    if(maxDepth <= 0) return {};
    const result = {};
    for(const [key, val] of Object.entries(obj || {})){
      if(typeof val === "string")        result[key] = sanitize(val);
      else if(typeof val === "number")   result[key] = Number.isFinite(val) ? val : 0;
      else if(typeof val === "boolean")  result[key] = val;
      else if(Array.isArray(val))        result[key] = val.map(v => typeof v === "string" ? sanitize(v) : typeof v === "object" ? sanitizeObject(v, maxDepth-1) : v);
      else if(val && typeof val === "object") result[key] = sanitizeObject(val, maxDepth-1);
    }
    return result;
  }

  /* ════════════════════════════════════════════════════════
     4. VALIDATION
  ════════════════════════════════════════════════════════ */

  function validateKenyanPhone(phone){
    const clean = String(phone || "").replace(/\s+/g, "").replace(/^(\+254|0254)/, "0");
    return /^0[71]\d{8}$/.test(clean) || /^0[34]\d{8}$/.test(clean);
  }

  function validateEmail(email){
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || ""));
  }

  function validateAmount(amount, min = 1, max = 10000000){
    const n = Number(amount);
    return Number.isFinite(n) && n >= min && n <= max;
  }

  function validateKRAPin(pin){
    return /^[AP]\d{9}[A-Z]$/.test(String(pin || "").toUpperCase());
  }

  /* ════════════════════════════════════════════════════════
     5. PAYMENT SECURITY
     Rules for safe payment handling in the browser.
  ════════════════════════════════════════════════════════ */

  const PaymentSecurity = {

    /**
     * Validate M-Pesa phone before STK push.
     * Returns { valid, normalised } where normalised is 254XXXXXXXXX.
     */
    normaliseMpesaPhone(phone){
      let p = String(phone || "").replace(/\s+/g, "");
      if(p.startsWith("+254")) p = p.replace("+254", "254");
      else if(p.startsWith("0"))  p = "254" + p.slice(1);
      const valid = /^254[71]\d{8}$/.test(p) || /^254[34]\d{8}$/.test(p);
      return { valid, normalised: valid ? p : null };
    },

    /**
     * Mask card number for display — only show last 4 digits.
     */
    maskCard(cardNum){
      const digits = String(cardNum).replace(/\D/g,"");
      return "•••• •••• •••• " + (digits.slice(-4) || "••••");
    },

    /**
     * Validate card expiry MM/YY — must be in the future.
     */
    validateCardExpiry(expiry){
      const match = String(expiry).match(/^(\d{1,2})[\s\/\-](\d{2,4})$/);
      if(!match) return false;
      const month = parseInt(match[1]);
      const year  = parseInt(match[2]) < 100 ? 2000 + parseInt(match[2]) : parseInt(match[2]);
      const now   = new Date();
      return month >= 1 && month <= 12 && (year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth()+1));
    },

    /**
     * Never log or expose full card details.
     * Call this before any card data reaches localStorage.
     */
    redactCardData(obj){
      const safe = { ...obj };
      delete safe.cardNum;
      delete safe.cvv;
      delete safe.cardNumber;
      delete safe.cvvCode;
      return safe;
    },

    /**
     * Verify the amount displayed matches the stored cart total.
     * Prevents UI manipulation attacks.
     */
    verifyOrderAmount(displayedAmount, cartItems){
      const cartTotal = (cartItems || []).reduce((sum, item) => sum + (Number(item.price)||0) * (Number(item.qty)||1), 0);
      const diff = Math.abs(Number(displayedAmount) - cartTotal);
      return diff < 1; /* Allow 1 KES rounding tolerance */
    }
  };

  /* ════════════════════════════════════════════════════════
     6. CSRF PROTECTION
     Token stored in sessionStorage — validated on form submit.
  ════════════════════════════════════════════════════════ */

  function generateCSRFToken(){
    const token = Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2,"0")).join("");
    sessionStorage.setItem("_sokoni_csrf", token);
    return token;
  }

  function validateCSRFToken(token){
    return token && token === sessionStorage.getItem("_sokoni_csrf");
  }

  /* ════════════════════════════════════════════════════════
     7. RATE LIMITING (client-side)
     Prevents button-spam attacks on payment & booking forms.
  ════════════════════════════════════════════════════════ */

  const _rateLimits = {};

  function rateLimit(key, maxCalls = 3, windowMs = 60000){
    const now = Date.now();
    if(!_rateLimits[key]) _rateLimits[key] = [];
    _rateLimits[key] = _rateLimits[key].filter(t => now - t < windowMs);
    if(_rateLimits[key].length >= maxCalls) return false;
    _rateLimits[key].push(now);
    return true;
  }

  /* ════════════════════════════════════════════════════════
     8. SECURE LOCALSTORAGE HELPERS
     Prevents injection when reading back from localStorage.
  ════════════════════════════════════════════════════════ */

  function safeGetJSON(key, fallback = null){
    try {
      const raw = localStorage.getItem(key);
      if(!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed;
    } catch(e) {
      console.warn("[SokoniSecurity] localStorage parse error for key:", key);
      return fallback;
    }
  }

  function safeSetJSON(key, value){
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch(e) {
      console.warn("[SokoniSecurity] localStorage write error:", e.message);
      return false;
    }
  }

  /* ════════════════════════════════════════════════════════
     9. PASSWORD STRENGTH VALIDATION
  ════════════════════════════════════════════════════════ */

  function validatePassword(pw){
    if(!pw || pw.length < 8)  return { ok:false, msg:'Password must be at least 8 characters.' };
    if(!/[A-Z]/.test(pw))     return { ok:false, msg:'Password needs at least one uppercase letter.' };
    if(!/[a-z]/.test(pw))     return { ok:false, msg:'Password needs at least one lowercase letter.' };
    if(!/[0-9]/.test(pw))     return { ok:false, msg:'Password needs at least one number.' };
    return { ok:true, msg:'' };
  }

  /* ════════════════════════════════════════════════════════
     10. URL SANITISATION — prevents open-redirect attacks
  ════════════════════════════════════════════════════════ */

  function sanitizeURL(url, allowedHosts){
    try {
      var u = new URL(url, window.location.origin);
      if(!['http:','https:'].includes(u.protocol)) return null;
      if(allowedHosts && allowedHosts.length){
        var ok = allowedHosts.some(function(h){
          return u.hostname === h || u.hostname.endsWith('.'+h);
        });
        if(!ok) return null;
      }
      return u.href;
    } catch(e){ return null; }
  }

  /* ════════════════════════════════════════════════════════
     11. PERSISTENT RATE LIMITING — survives page refresh
  ════════════════════════════════════════════════════════ */

  var _PRL_KEY = '_sk_rl';
  function persistentRateLimit(key, maxCalls, windowMs){
    maxCalls = maxCalls || 5;
    windowMs = windowMs || 60000;
    var now = Date.now();
    var store;
    try{ store = JSON.parse(sessionStorage.getItem(_PRL_KEY) || '{}'); }
    catch(e){ store = {}; }
    store[key] = (store[key] || []).filter(function(t){ return now - t < windowMs; });
    if(store[key].length >= maxCalls) return false;
    store[key].push(now);
    try{ sessionStorage.setItem(_PRL_KEY, JSON.stringify(store)); } catch(e){}
    return true;
  }

  /* ════════════════════════════════════════════════════════
     12. LOGIN LOCKOUT — blocks brute-force login attempts
  ════════════════════════════════════════════════════════ */

  var _LO_KEY      = '_sk_lockout';
  var _LO_MAX_FAIL = 5;
  var _LO_DURATION = 15 * 60 * 1000;

  function recordFailedLogin(identifier){
    var now = Date.now();
    var store;
    try{ store = JSON.parse(localStorage.getItem(_LO_KEY) || '{}'); }
    catch(e){ store = {}; }
    var entry = store[identifier] || { count:0, until:0 };
    if(entry.until && now >= entry.until){ entry = { count:0, until:0 }; }
    entry.count++;
    entry.lastAt = now;
    if(entry.count >= _LO_MAX_FAIL){
      entry.until = now + _LO_DURATION;
      entry.count = 0;
    }
    store[identifier] = entry;
    try{ localStorage.setItem(_LO_KEY, JSON.stringify(store)); } catch(e){}
    return entry;
  }

  function isLoginLocked(identifier){
    try{
      var store = JSON.parse(localStorage.getItem(_LO_KEY) || '{}');
      var entry = store[identifier];
      if(!entry || !entry.until || Date.now() >= entry.until) return false;
      var minsLeft = Math.ceil((entry.until - Date.now()) / 60000);
      return { locked:true, until:entry.until, minsLeft:minsLeft };
    } catch(e){ return false; }
  }

  function clearLoginLockout(identifier){
    try{
      var store = JSON.parse(localStorage.getItem(_LO_KEY) || '{}');
      delete store[identifier];
      localStorage.setItem(_LO_KEY, JSON.stringify(store));
    } catch(e){}
  }

  /* ════════════════════════════════════════════════════════
     13. CENTRALISED ERROR HANDLER
     Maps technical codes → user-friendly messages.
     Never exposes stack traces or internal error codes.
  ════════════════════════════════════════════════════════ */

  var _ERR_MAP = {
    'auth/wrong-password':         'Wrong email or password.',
    'auth/user-not-found':         'Wrong email or password.',
    'auth/too-many-requests':      'Too many attempts. Try again later.',
    'auth/email-already-in-use':   'An account with that email already exists.',
    'auth/weak-password':          'Password is too weak. Choose a stronger one.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/invalid-email':          'Please enter a valid email address.',
    'permission-denied':           'Access denied.',
    'unavailable':                 'Service temporarily unavailable. Try again.',
    'not-found':                   'The requested resource was not found.',
    'quota-exceeded':              'Service limit reached. Try again later.',
  };

  function handleError(err, context){
    var msg;
    if(err && typeof err === 'object'){
      msg = _ERR_MAP[err.code] || _ERR_MAP[err.message] || 'Something went wrong. Please try again.';
    } else if(typeof err === 'string'){
      msg = _ERR_MAP[err] || err;
    } else {
      msg = 'An unexpected error occurred.';
    }
    if(typeof console !== 'undefined'){
      console.warn('[SOKONI]', context || 'error', err && err.code ? err.code : '');
    }
    return msg;
  }

  /* ════════════════════════════════════════════════════════
     14. AUTO-INIT
     Runs immediately when script is loaded.
  ════════════════════════════════════════════════════════ */

  /* ════════════════════════════════════════════════════════
     PRECONNECT INJECTION
     Fires once per page, from security.js which loads first
     on every page — so all 60+ pages get these hints for free.
  ════════════════════════════════════════════════════════ */
  function _injectPreconnects(){
    var hints = [
      { rel:'preconnect',   href:'https://cdnjs.cloudflare.com',       co:true  },
      { rel:'preconnect',   href:'https://fonts.gstatic.com',           co:true  },
      { rel:'preconnect',   href:'https://www.gstatic.com',             co:false },
      { rel:'dns-prefetch', href:'https://firestore.googleapis.com'              },
      { rel:'dns-prefetch', href:'https://storage.googleapis.com'                },
      { rel:'dns-prefetch', href:'https://analytics.google.com'                  },
      { rel:'dns-prefetch', href:'https://api.intasend.com'                      },
    ];
    var frag = document.createDocumentFragment();
    hints.forEach(function(h){
      if(document.querySelector('link[rel="'+h.rel+'"][href="'+h.href+'"]')) return;
      var l = document.createElement('link');
      l.rel  = h.rel;
      l.href = h.href;
      if(h.co) l.crossOrigin = 'anonymous';
      frag.appendChild(l);
    });
    document.head.appendChild(frag);
  }

  function init(){
    /* Inject CSP meta tag as defence-in-depth (HTTP header is authoritative) */
    injectCSP();

    /* Generate CSRF token for this session */
    if(!sessionStorage.getItem("_sokoni_csrf")) generateCSRFToken();

    /* Inject preconnect/dns-prefetch hints for all external domains */
    _injectPreconnects();

    /* Enforce HTTPS in production */
    if(location.protocol === "http:" && !location.hostname.includes("localhost") && !location.hostname.includes("127.0.0.1")){
      location.replace(location.href.replace("http://", "https://"));
    }

    /* Disable right-click inspect on payment modals only */
    document.addEventListener("keydown", e => {
      const inPayment = document.querySelector(".mpesa-overlay.open, .card-overlay.open");
      if(inPayment && e.key === "F12"){ e.preventDefault(); }
    });

    /* Privacy / Cookie consent banner — Kenya Data Protection Act 2019 */
    if(!localStorage.getItem("sokoniPrivacyAccepted")){
      const _showBanner = function(){
        if(document.getElementById("_sokoniPrivacyBanner")) return;
        const b = document.createElement("div");
        b.id = "_sokoniPrivacyBanner";
        /* ── CENTRED CONSENT MODAL, WITH A BACKDROP ───────────────────────────────
           History, because it explains why this is a modal and not a bar:

           1. It began as a two-block banner (heading, four lines of copy, two inline links,
              "Learn More" + "Accept", flex-wrap). On a phone it wrapped to 184px — 28% of a
              664px viewport — and covered EIGHT Seller Dashboard quick actions. Tapping
              POS/Cashier landed on the Accept button: the seller's first tap silently
              consented to cookies instead of opening the till.

           2. Shrinking it to a 62px bar helped but did NOT fix it. Measured in an
              authenticated session, FOUR cards were still covered — POS among them — and a
              tap on the centre of "Revenue" still landed on #_sokoniPrivacyAcceptBtn. That
              is inherent: a fixed bar of ANY height sits over whatever is at the foot of the
              viewport. Height was never the real problem; overlaying live controls was.

           So: a centred modal over a backdrop. The backdrop is the point — every stray tap
           lands on IT and does nothing, so a quick action can never be silently traded for a
           consent. It is also honest: the page IS blocked until the user answers, and it now
           looks blocked instead of pretending to be usable.

           The element keeps its id (#_sokoniPrivacyBanner) — other code and the CI gates
           reference it. */
        b.style.cssText = [
          "position:fixed","inset:0",
          "z-index:99997",
          "display:flex","align-items:center","justify-content:center",
          "padding:20px",
          "padding-bottom:calc(20px + env(safe-area-inset-bottom, 0px))",
          "padding-top:calc(20px + env(safe-area-inset-top, 0px))",
          "box-sizing:border-box",
          "background:rgba(0,0,0,0.66)",
          "backdrop-filter:blur(4px)",
          "-webkit-backdrop-filter:blur(4px)",
          "font-family:'Segoe UI',system-ui,sans-serif"
        ].join(";");
        b.setAttribute("role", "dialog");
        b.setAttribute("aria-modal", "true");
        b.setAttribute("aria-labelledby", "_sokoniPrivacyTitle");
        b.innerHTML = [
          "<div style='width:100%;max-width:400px;box-sizing:border-box;",
            "background:#0d0d0d;border:1px solid rgba(113,255,0,0.22);border-radius:18px;",
            "padding:22px 20px;box-shadow:0 20px 60px rgba(0,0,0,0.7);'>",

            "<div id='_sokoniPrivacyTitle' style='font-size:16px;font-weight:800;color:white;margin-bottom:8px;'>",
              "🍪 Privacy &amp; Cookies</div>",

            "<div style='font-size:13px;line-height:1.6;color:rgba(255,255,255,0.6);margin-bottom:18px;'>",
              "SOKONI uses cookies and local storage to deliver and improve your experience. ",
              "By continuing you accept our ",
              "<a href='legal.html#privacy' style='color:#71ff00;text-decoration:underline;'>Privacy Policy</a>",
              " and ",
              "<a href='legal.html#cookies' style='color:#71ff00;text-decoration:underline;'>Cookie Policy</a>",
              ", in compliance with the Kenya Data Protection Act 2019.",
            "</div>",

            /* Both controls hold the 44px touch floor. */
            "<button id='_sokoniPrivacyAcceptBtn' aria-label='Accept cookies' ",
              "style='width:100%;min-height:48px;",
              "background:linear-gradient(135deg,#71ff00,#4fc800);color:black;border:none;",
              "border-radius:12px;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;'>",
              "Accept</button>",

            "<a href='legal.html#privacy' ",
              "style='display:flex;align-items:center;justify-content:center;min-height:44px;margin-top:8px;",
              "color:rgba(255,255,255,0.45);font-size:12px;font-weight:700;text-decoration:none;'>",
              "Learn more</a>",

          "</div>"
        ].join("");
        document.body.appendChild(b);

        /* Keyboard users must be able to reach Accept without tabbing the page behind. */
        try { document.getElementById("_sokoniPrivacyAcceptBtn").focus({ preventScroll: true }); } catch (_) {}

        /* The old bar was position:fixed at the foot of the page, so it reserved body
           padding to avoid overlaying the controls beneath it. A MODAL needs the opposite:
           it deliberately covers everything, and reserving its height as padding would add a
           full viewport of dead space under the page.

           What a modal owes the user instead is: nothing behind it can be tapped (the
           backdrop guarantees that), and the page behind must not scroll away under it.

           --sk-consent-h is published as 0 because the seller sidebar subtracts it from its
           own height (`height: calc(100vh - var(--sk-consent-h))`). With a modal there is no
           strip of screen to give up, and leaving a stale value there would shrink the
           sidebar for no reason. */
        var _basePad = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
        var _baseOverflow = document.body.style.overflow || '';

        var _pad = function(){
          document.documentElement.style.setProperty('--sk-consent-h', '0px');
          /* Scroll-lock the page behind the modal. */
          document.body.style.setProperty('overflow', 'hidden');
          /* Hide the FABs: they sit below the backdrop anyway, but hiding them also takes
             them out of the tab order while the dialog owns focus. */
          _liftFabs(0);
        };

        /* The floating buttons are position:fixed at the foot of the screen, so no amount of
           body padding moves them — the banner sat squarely on top of the KASS button and the
           back-to-top button and swallowed their taps.

           TWO stylesheets already fight over these buttons with !important —
           sokoni-responsive.css  { bottom: var(--sk-fab-clear) !important }  and
           sokoni-mobile-fixes.css { bottom: max(82px, …) !important }
           so setting a CSS variable is not reliable: whichever rule wins the cascade may not
           read it. (That is exactly why lifting --sk-kass-bottom did nothing.) An inline
           !important cannot be out-cascaded by either. Each button's own base offset is
           remembered, so Accept restores it exactly. */
        var FAB_SEL = '#sokoniScrollTop,#kassBtn,#sokoni-wa-support,.back-to-top-btn,.sk-fab,.fab';

        /* Lifting the buttons by the banner's full height stopped the banner swallowing
           their taps — but it created a worse problem. On a phone the banner wraps to
           ~184px, which is 28% of a 664px viewport, so the buttons landed at bottom:270px:
           levitated into the MIDDLE of the page, sitting on top of the content. Measured in
           an authenticated Seller Dashboard session, that put the back-to-top button
           squarely over the "Add Product" quick action and the chat button over "KRA Tax".

           A transient banner must not relocate permanent furniture into the content. While
           the banner is up, hide the buttons instead: a hidden button cannot have its taps
           swallowed either, the consent bar is the only thing the user should be answering,
           and Accept restores them to their real positions immediately.

           visibility (not display) keeps their layout box intact so nothing else reflows,
           and pointer-events:none guarantees they cannot eat a tap while invisible. */
        var _liftFabs = function (h) {
          document.querySelectorAll(FAB_SEL).forEach(function (el) {
            if (el.__skFabHidden) return;
            el.__skFabHidden = true;
            el.style.setProperty('visibility', 'hidden', 'important');
            el.style.setProperty('pointer-events', 'none', 'important');
          });
        };
        var _dropFabs = function () {
          document.querySelectorAll(FAB_SEL).forEach(function (el) {
            el.style.removeProperty('visibility');
            el.style.removeProperty('pointer-events');
            /* Older builds lifted the buttons with an inline `bottom`. Clear it so a
               returning user is not left with a permanently levitated FAB. */
            el.style.removeProperty('bottom');
            el.__skFabHidden = false;
            el.__skFabBase = null;
          });
        };

        /* MEASURE AFTER LAYOUT, NOT DURING IT.
           _pad() used to run synchronously on the line after appendChild, when the banner had
           not yet reflowed. On a phone it wraps to ~184px, but the height read at that instant
           was ~80px — so most of the banner still overlaid the page. On /login that left
           "Create Account", "Continue as Guest" and the phone-number fields underneath it,
           looking perfectly normal and simply not responding to a tap.

           Two frames for the initial read (one to lay out, one to settle), then a
           ResizeObserver so the reservation tracks the banner through font loading, text
           wrapping and rotation — the cases where its height actually changes. */
        requestAnimationFrame(function(){ requestAnimationFrame(_pad); });
        /* The FABs are injected by deferred scripts (kass-widget, scroll-top) that may not have
           run yet. Re-apply a few times so a late arrival is lifted too. */
        [400, 1200, 2500, 5000].forEach(function (ms) { setTimeout(function () { _pad(); }, ms); });
        if (typeof ResizeObserver === 'function') {
          var _ro = new ResizeObserver(_pad);
          _ro.observe(b);
          b.__skRO = _ro;                          /* so accept() can disconnect it */
        }
        window.addEventListener('resize', _pad);   /* it reflows/wraps on narrow screens */

        document.getElementById("_sokoniPrivacyAcceptBtn").onclick = function(){
          localStorage.setItem("sokoniPrivacyAccepted", Date.now().toString());
          /* Fade the backdrop out. (The old slide-down belonged to a bottom bar; on a
             centred dialog it would have slid the modal off the bottom of the screen.) */
          b.style.setProperty('opacity', '0');
          b.style.setProperty('transition', 'opacity .25s ease');
          b.style.setProperty('pointer-events', 'none');
          window.removeEventListener('resize', _pad);
          if (b.__skRO) { b.__skRO.disconnect(); b.__skRO = null; }
          _dropFabs();                             /* buttons come back */
          /* Release the scroll lock, and clear any padding an OLDER build left behind — a
             returning user must not be stuck with a permanent gap under the page. */
          document.body.style.removeProperty('overflow');
          document.body.style.removeProperty('padding-bottom');
          document.documentElement.style.setProperty('--sk-consent-h', '0px');
          setTimeout(function(){ if(b.isConnected) b.remove(); }, 300);
        };
      };
      /* Show after DOM is ready, skip on legal/auth pages to avoid clutter */
      var _skipPages = ["legal.html","login.html","signup.html","register.html"];
      var _thisPage = location.pathname.split("/").pop() || "index.html";
      if(!_skipPages.includes(_thisPage)){
        if(document.readyState === "loading"){
          document.addEventListener("DOMContentLoaded", function(){ setTimeout(_showBanner, 1500); });
        } else {
          setTimeout(_showBanner, 1500);
        }
      }
    }
  }

  init();

  return {
    escapeHTML,
    safeText,
    safeHTML,
    sanitize,
    sanitizeObject,
    validateKenyanPhone,
    validateEmail,
    validateAmount,
    validateKRAPin,
    validatePassword,
    PaymentSecurity,
    generateCSRFToken,
    validateCSRFToken,
    rateLimit,
    persistentRateLimit,
    recordFailedLogin,
    isLoginLocked,
    clearLoginLockout,
    sanitizeURL,
    handleError,
    safeGetJSON,
    safeSetJSON
  };

})();

window.SokoniSecurity = SokoniSecurity;

/* ── Convenience global aliases ── */
window.escapeHTML        = SokoniSecurity.escapeHTML;
window.sanitizeInput     = SokoniSecurity.sanitize;
window.safeGetJSON       = SokoniSecurity.safeGetJSON;
window.safeSetJSON       = SokoniSecurity.safeSetJSON;
window.validatePassword  = SokoniSecurity.validatePassword;
window.sanitizeURL       = SokoniSecurity.sanitizeURL;
window.handleError       = SokoniSecurity.handleError;

/* ════════════════════════════════════════════════════════════
   UNIVERSAL PAGE SHIELD
   Prevents harmful/jarring flash of unstyled/partial content
   on every page. Injects a branded loading curtain into <head>
   that fades away once the page is ready. index.html has its
   own full-screen splash so the shield is skipped there.
════════════════════════════════════════════════════════════ */
(function(){
  var isIndexPage = /\/(index\.html)?(\?|#|$)/.test(window.location.pathname);
  if(isIndexPage) return; /* index has its own premium splash */
  if(document.documentElement.getAttribute('data-splash')) return; /* splash.js declared in <html> */
  if(document.getElementById('splashScreen')) return; /* splash.js already ran */

  /* Inject shield CSS before body renders — prevents FOUC and
     raw content appearing before styles are applied.          */
  var shieldCSS = document.createElement('style');
  shieldCSS.id  = 'sokoniPageShieldCSS';
  shieldCSS.textContent = [
    '#sokoniPageShield{',
      'position:fixed;inset:0;',
      'background:#090909;',
      'z-index:2147483647;',         /* max z-index */
      'display:flex;flex-direction:column;',
      'align-items:center;justify-content:center;',
      'gap:0;',
      'opacity:1;',
      'transition:opacity 0.55s cubic-bezier(0.4,0,0.2,1);',
      'pointer-events:all;',
    '}',
    '#sokoniPageShield.shield-out{opacity:0;pointer-events:none;}',
    '#sokoniPageShield img{width:72px;opacity:0.85;',
      'animation:_sk_pulse 1.6s ease-in-out infinite;}',
    '#sokoniPageShield .sk-ring{',
      'width:44px;height:44px;',
      'border:3px solid rgba(113,255,0,0.1);',
      'border-top-color:#71ff00;',
      'border-radius:50%;',
      'margin-top:18px;',
      'animation:_sk_spin 0.85s linear infinite;',
    '}',
    '@keyframes _sk_pulse{0%,100%{opacity:0.7;transform:scale(1);}',
      '50%{opacity:1;transform:scale(1.05);}}',
    '@keyframes _sk_spin{to{transform:rotate(360deg);}}'
  ].join('');
  document.head.appendChild(shieldCSS);

  /* Inject shield element as soon as <body> exists */
  function mountShield(){
    if(document.getElementById('sokoniPageShield')) return;
    if(document.getElementById('splashScreen')) return; /* splash.js already running */
    var shield = document.createElement('div');
    shield.id  = 'sokoniPageShield';
    shield.innerHTML =
      '<img src="assets/sokoni-logo-dark.png" alt="SOKONI" onerror="this.style.display=\'none\'">' +
      '<div class="sk-ring"></div>';
    /* Insert at very top of body */
    if(document.body){
      document.body.insertBefore(shield, document.body.firstChild);
    } else {
      document.addEventListener('DOMContentLoaded', function(){
        document.body.insertBefore(shield, document.body.firstChild);
        scheduleHide(shield);
      }, {once:true});
      return;
    }
    scheduleHide(shield);
  }

  function scheduleHide(shield){
    var _done = false;
    function hideShield(){
      if(_done) return;
      _done = true;
      shield.classList.add('shield-out');
      setTimeout(function(){
        if(shield.parentNode) shield.parentNode.removeChild(shield);
        var css = document.getElementById('sokoniPageShieldCSS');
        if(css && css.parentNode) css.parentNode.removeChild(css);
      }, 600);
    }
    /* Fixed-timer hide — no window.load dependency */
    setTimeout(hideShield, 500);
    /* Hard failsafe at 2.5 s */
    setTimeout(hideShield, 2500);
  }

  /* Try immediately; DOMContentLoaded is the reliable fallback */
  if(document.body){
    mountShield();
  } else {
    document.addEventListener('DOMContentLoaded', mountShield, {once:true});
  }
})();

/* ════════════════════════════════════════════════════════════
   GLOBAL PERFORMANCE & CRASH PREVENTION
   Applied to every SOKONI page via security.js (loads first).
════════════════════════════════════════════════════════════ */
(function(){
  /* 1. Catch unhandled Promise rejections (Firebase network errors,
        dynamic import failures, etc.) — prevents page-wide crashes  */
  window.addEventListener('unhandledrejection', function(e){
    var reason = e.reason;
    var msg = reason && (reason.message || reason.code || String(reason));
    /* Auth/App Check errors are surfaced by their own handlers, so a benign transient
       rejection here must not crash the page. Swallow known-transient classes only —
       anything else still propagates so real bugs stay visible. */
    if(!msg || /network|quota|offline|unavailable|aborted|fetch|firebase/i.test(msg)){
      e.preventDefault();
    }
  });

  /* 2. Passive touch/scroll listeners — eliminates scroll jank on mobile */
  try {
    var _opts = { passive: true };
    document.addEventListener('touchstart', function(){}, _opts);
    document.addEventListener('touchmove',  function(){}, _opts);
    document.addEventListener('touchend',   function(){}, _opts);
    document.addEventListener('wheel',      function(){}, _opts);
  } catch(e){}

  /* 3. Prevent localStorage parse crashes from corrupted data */
  var _origGetItem = Storage.prototype.getItem;
  Storage.prototype.getItem = function(key){
    try{ return _origGetItem.call(this, key); }
    catch(e){ console.warn('[SOKONI] localStorage.getItem failed:', key); return null; }
  };

  /* 4. requestAnimationFrame fallback for older WebViews */
  if(!window.requestAnimationFrame){
    window.requestAnimationFrame = function(cb){ return setTimeout(cb, 16); };
  }

  /* 5. Debounce utility — available globally for any page */
  window.sokoniDebounce = function(fn, ms){
    var t;
    return function(){
      var a = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function(){ fn.apply(ctx, a); }, ms);
    };
  };
})();
