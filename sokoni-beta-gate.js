/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Beta gate (client)

   Consumes the betaStatus custom claim set by functions/beta-access.js.

   GATES ACTIONS, NOT PAGES — and that is the whole design.

   The Continuous Production Beta model is "everyone may visit, browse and
   apply; only approved users transact". Gating whole PAGES would break that in
   the most expensive possible way: product and store pages are the platform's
   organic growth engine — Google indexes them, merchants share them on
   WhatsApp, QR codes point at them. A page gate would make every one of those
   links a dead end for the exact audience they exist to attract, and would
   remove the pages from search entirely.

   So browsing stays open to everyone, including signed-out visitors and
   crawlers. The gate sits on the ACTIONS that commit a user to the platform:
   checkout, selling, riding.

   THIS IS NOT THE SECURITY BOUNDARY. Firestore rules and the Cloud Functions
   are. A determined client can call gate() and ignore the answer — which is why
   betaReview sets a signed claim that the server checks independently. This
   layer exists so an unapproved user meets an explanation instead of a
   permission error.
   ══════════════════════════════════════════════════════════════════════════ */
window.SokoniBetaGate = (() => {
  'use strict';

  const ADMITTED = ['approved', 'founder', 'internal'];
  let _cache = null;          /* per page load; a review revokes tokens anyway */

  /* Read the claim from the ID token — no network call, no Firestore read.
     forceRefresh is used only after applying, when the token predates the
     decision. */
  async function status(forceRefresh) {
    if (_cache && !forceRefresh) return _cache;

    const auth = window.firebaseAuth;
    const user = auth && auth.currentUser;
    if (!user) { _cache = { signedIn: false, betaStatus: 'none', admitted: false, isStaff: false }; return _cache; }

    let claims = {};
    try {
      const res = await user.getIdTokenResult(!!forceRefresh);
      claims = res.claims || {};
    } catch (e) {
      /* Fail CLOSED for admission, but do not pretend to know the status: an
         unreadable token must not read as approved. */
      console.warn('[BetaGate] could not read claims:', e && e.message);
      return { signedIn: true, betaStatus: 'unknown', admitted: false, isStaff: false, error: true };
    }

    const s = claims.betaStatus || 'none';
    _cache = {
      signedIn: true,
      betaStatus: s,
      /* Staff are never gated out of their own platform. */
      isStaff: !!(claims.admin || claims.superAdmin),
      admitted: ADMITTED.includes(s) || !!(claims.admin || claims.superAdmin),
    };
    return _cache;
  }

  const COPY = {
    none:       { t: 'Join the SOKONI beta',      b: 'We are admitting new members every day. Apply to start buying and selling.', cta: 'Apply now',        href: '/beta' },
    pending:    { t: 'Your application is in review', b: 'We admit new members daily. You will be notified the moment you are approved.', cta: 'View your application', href: '/beta' },
    waitlisted: { t: 'You are on the waitlist',   b: 'You are in the queue. Inviting friends moves you up it.', cta: 'View your place', href: '/beta' },
    suspended:  { t: 'Account access paused',      b: 'Your marketplace access is currently paused. Our team can help.', cta: 'Contact support', href: '/support' },
    rejected:   { t: 'Application not approved',   b: 'Your application was not approved at this time.', cta: 'Contact support', href: '/support' },
    unknown:    { t: 'Could not verify your access', b: 'Please refresh and try again.', cta: 'Refresh', href: '' },
  };

  function _sheet(state) {
    const c = COPY[state] || COPY.none;
    const wrap = document.createElement('div');
    wrap.id = 'sk-beta-sheet';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.style.cssText = [
      /* Was a hardcoded z-index:99998 — BELOW the global header (--sk-z-header,
         100001). This is a full-screen blocking gate, so per
         docs/OVERLAY_ARCHITECTURE.md ("If it covers the header, it must out-rank
         the header") it belongs on the sheet tier, not under the nav. At 99998
         the header painted over it and its controls could be intercepted. */
      'position:fixed', 'inset:0', 'z-index:var(--sk-z-sheet,100010)', 'display:flex',
      'align-items:flex-end', 'justify-content:center',
      'background:rgba(0,0,0,.62)', 'animation:skBetaFade .2s ease',
    ].join(';');
    wrap.innerHTML =
      '<style>@keyframes skBetaFade{from{opacity:0}to{opacity:1}}' +
      '@keyframes skBetaUp{from{transform:translateY(18px);opacity:0}to{transform:none;opacity:1}}</style>' +
      '<div style="width:100%;max-width:460px;background:#0d0d0d;border:1px solid #1c1c1c;' +
      'border-radius:20px 20px 0 0;padding:26px 22px calc(26px + env(safe-area-inset-bottom,0px));' +
      'animation:skBetaUp .24s ease;font-family:inherit;">' +
        '<div style="width:38px;height:4px;border-radius:99px;background:#2a2a2a;margin:0 auto 18px;"></div>' +
        '<div style="font-size:19px;font-weight:800;color:#fff;letter-spacing:-.02em;margin-bottom:8px;">' + c.t + '</div>' +
        '<div style="font-size:13.5px;color:#8a8a8a;line-height:1.6;margin-bottom:20px;">' + c.b + '</div>' +
        '<div style="display:flex;gap:9px;">' +
          (c.href
            ? '<a href="' + c.href + '" style="flex:1;text-align:center;padding:13px;border-radius:12px;background:#71ff00;color:#000;font-weight:800;font-size:14px;text-decoration:none;min-height:46px;display:flex;align-items:center;justify-content:center;">' + c.cta + '</a>'
            : '<button type="button" onclick="location.reload()" style="flex:1;padding:13px;border-radius:12px;border:none;background:#71ff00;color:#000;font-weight:800;font-size:14px;font-family:inherit;min-height:46px;">' + c.cta + '</button>') +
          '<button type="button" data-sk-beta-close style="padding:13px 18px;border-radius:12px;border:1px solid #222;background:#141414;color:#8a8a8a;font-weight:700;font-size:14px;font-family:inherit;min-height:46px;">Keep browsing</button>' +
        '</div>' +
      '</div>';

    const close = () => wrap.remove();
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.hasAttribute('data-sk-beta-close')) close();
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    return wrap;
  }

  /* ── gate(action) ─────────────────────────────────────────────────────────
     Returns true if the caller may proceed. Otherwise explains why and returns
     false. "Keep browsing" is always offered, because browsing is never gated. */
  async function gate(action) {
    const s = await status();

    if (!s.signedIn) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = '/login.html?next=' + next;
      return false;
    }
    if (s.admitted) return true;

    document.body.appendChild(_sheet(s.betaStatus));
    console.info('[BetaGate] blocked action=' + (action || 'unknown') + ' status=' + s.betaStatus);
    return false;
  }

  /* Declarative form: any element with data-beta-gate is intercepted in the
     CAPTURE phase, so an existing inline onclick cannot fire first. */
  function wire(root) {
    (root || document).querySelectorAll('[data-beta-gate]').forEach((el) => {
      if (el.__skGated) return;
      el.__skGated = true;
      el.addEventListener('click', async (e) => {
        const s = await status();
        if (s.admitted) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        document.body.appendChild(_sheet(s.betaStatus));
      }, true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => wire());
  } else { wire(); }

  return { status, gate, wire, ADMITTED, refresh: () => status(true) };
})();
