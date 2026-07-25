'use strict';

/**
 * SOKONI Public Profile Page v1.0
 *
 * Markup for https://mysokoni.co.ke/profile/{uid}. Kept apart from
 * profile-engine.js so the engine stays about data and this stays about
 * presentation — and so the rendering can be tested without a Firestore
 * connection (see scripts/test-public-pages.js).
 *
 * SECURITY: every value reaching this file is another member's Firestore
 * document. All of it goes through esc/attr/httpsUrl. Never interpolate a
 * raw value into the markup below.
 */

const { esc, attr, httpsUrl, metaBlock } = require('./html-render');

/* ── Public profile markup ─────────────────────────────────────────────────
   Rendered server-side rather than fetched by client JS, for one reason that
   client rendering cannot solve: link preview crawlers do not run JavaScript.
   A client-rendered page can only ever show the same generic card for every
   member, which is the defect this endpoint exists to fix.

   Server rendering also removes a round trip (document, then XHR) and makes
   the page work with JS disabled.

   Every interpolation below goes through esc/attr/httpsUrl from html-render —
   these are other people's display names and bios being written into markup.
──────────────────────────────────────────────────────────────────────────── */

const PROFILE_CSS = `
:root{--pp-bg:#050505;--pp-card:#0d0d0d;--pp-line:rgba(255,255,255,.08);--pp-text:#f2f2f2;--pp-muted:rgba(255,255,255,.55);--pp-accent:#71ff00}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--pp-bg);color:var(--pp-text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;min-height:100vh;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
.pp-wrap{max-width:560px;margin:0 auto;padding:28px 18px 64px}
.pp-brand{display:flex;align-items:center;gap:9px;margin-bottom:26px;text-decoration:none;color:var(--pp-text)}
.pp-brand img{width:30px;height:30px;border-radius:8px}
.pp-brand span{font-weight:800;letter-spacing:.4px;font-size:15px}
.pp-card{background:var(--pp-card);border:1px solid var(--pp-line);border-radius:18px;padding:30px 22px 26px;text-align:center}
.pp-avatar,.pp-initials{width:92px;height:92px;border-radius:50%;margin:0 auto 14px;border:2px solid var(--pp-accent)}
.pp-avatar{display:block;object-fit:cover;background:#1a1a1a}
.pp-initials{display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:800;color:var(--pp-accent);background:#141414}
.pp-name{font-size:21px;font-weight:800;margin:0 0 4px;overflow-wrap:anywhere}
.pp-headline{color:var(--pp-muted);font-size:14px;margin:0 0 12px;overflow-wrap:anywhere}
.pp-meta{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 14px;color:var(--pp-muted);font-size:12.5px;margin-bottom:16px}
.pp-badges,.pp-skills{display:flex;flex-wrap:wrap;justify-content:center;gap:7px;margin-bottom:18px}
.pp-badge{font-size:11.5px;font-weight:700;padding:5px 11px;border-radius:999px;background:rgba(113,255,0,.10);border:1px solid rgba(113,255,0,.32);color:var(--pp-accent);text-transform:capitalize}
.pp-badge--level{background:rgba(255,255,255,.06);border-color:var(--pp-line);color:var(--pp-text)}
.pp-skill{font-size:11.5px;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.05);border:1px solid var(--pp-line);color:var(--pp-muted)}
.pp-shop,.pp-secondary{display:block;text-decoration:none;font-weight:800;padding:14px;border-radius:12px;margin-bottom:10px}
.pp-shop{background:var(--pp-accent);color:#041000;font-size:15px}
.pp-secondary{border:1px solid var(--pp-line);color:var(--pp-text);font-weight:700;font-size:14px;padding:13px;margin-bottom:0}
.pp-sid{margin-top:18px;padding-top:16px;border-top:1px solid var(--pp-line);font-size:11.5px;color:rgba(255,255,255,.38);letter-spacing:.6px}
.pp-state{text-align:center;padding:60px 18px;color:var(--pp-muted)}
.pp-state h1{font-size:18px;color:var(--pp-text);margin:0 0 8px}
.pp-state p{font-size:14px;margin:0 0 22px}
`.trim();

function _shell(metaHtml, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#050505">
<link rel="icon" href="/assets/logosokoni.png">
  ${metaHtml}
<style>${PROFILE_CSS}</style>
</head>
<body>
<div class="pp-wrap">
  <a class="pp-brand" href="/"><img src="/assets/logosokoni.png" alt=""><span>SOKONI</span></a>
  <main>${bodyHtml}</main>
</div>
</body>
</html>`;
}

function _initials(name) {
  return (String(name || '?').trim().split(/\s+/)
    .map(w => w.charAt(0)).join('').slice(0, 2).toUpperCase()) || '?';
}

/** Gated profile page with a public preview card for link-preview crawlers.
 *
 * PRODUCT DECISION 2026-07-25 (owner-directed): the shared profile link is a
 * sign-up funnel, not a public page. So:
 *   • Link-preview crawlers (WhatsApp/Facebook/Google — no JS) still get a clean
 *     card from the OG tags: name as the title, photo as the image. The preview
 *     looks good, which is the whole point of server-rendering this endpoint.
 *   • A logged-OUT human sees ONLY a gate — create account / sign in / continue as
 *     guest. No bio, location, skills, shop or Sokoni ID is DISPLAYED.
 *   • A logged-IN human sees the full profile card (revealed by the script below).
 *
 * The gate is shown by default and the profile is display:none, so the default
 * (no-JS) state a crawler sees is the gate, never the member's details. The full
 * card markup is present but hidden; a signed-in visitor's browser reveals it. A
 * public shared URL has no auth context at render time, so this client reveal is
 * the only way to serve one HTML to crawler, guest and member — the standard
 * content-wall pattern. Sensitive-ish fields (Sokoni ID, exact location) are kept
 * OUT of the markup entirely so they are not even in page source for a guest.
 */
function _profilePage(d) {
  const name  = d.displayName || 'SOKONI Member';
  const photo = httpsUrl(d.photoURL);

  /* Gated preview description — deliberately generic. It must not leak the
     headline/location/shop, since the point is that those are behind the gate. */
  const meta = metaBlock({
    title:       `${name} — SOKONI`,
    description: `Create a free SOKONI account to view ${name}'s profile on Kenya's unified marketplace.`,
    image:       photo || 'https://mysokoni.co.ke/assets/logosokoni.png',
    url:         d.profileUrl,
    type:        'profile',
  });

  const avatar = photo
    ? `<img class="pp-avatar" src="${attr(photo, 500)}" alt="" loading="lazy">`
    : `<div class="pp-initials">${esc(_initials(name))}</div>`;

  const badges = [
    d.trustLevel ? `<span class="pp-badge pp-badge--level">${esc(d.trustLevel)}</span>` : '',
    ...(d.verifiedTypes || []).map(t => `<span class="pp-badge">✓ ${esc(t)}</span>`),
  ].filter(Boolean).join('');

  const skills = (d.skills || []).map(s => `<span class="pp-skill">${esc(s)}</span>`).join('');
  const shopUrl = d.shop && httpsUrl(d.shop.url);

  /* Where sign-in / sign-up should return to: back to this same link, so once the
     visitor has an account the reveal below shows the profile they came for. */
  const back = attr('redirect=' + encodeURIComponent(d.profileUrl || '/'), 500);

  /* GATE — the only thing a logged-out visitor sees. Name + avatar only (both are
     already public via the OG card), then the account/guest choices. */
  const gate = `<section class="pp-card" id="ppGate">
    ${avatar}
    <h1 class="pp-name">${esc(name)}</h1>
    <p class="pp-headline">Create a free account to view this profile on SOKONI.</p>
    <a class="pp-shop" href="/signup?${back}">Create account</a>
    <a class="pp-secondary" href="/login?${back}" style="margin-bottom:10px">Sign in</a>
    <a class="pp-secondary" href="/">Continue as guest — browse SOKONI</a>
  </section>`;

  /* PROFILE — hidden until the script confirms a signed-in visitor. */
  const profile = `<section class="pp-card" id="ppProfile" style="display:none">
    ${avatar}
    <h1 class="pp-name">${esc(name)}</h1>
    ${d.headline ? `<p class="pp-headline">${esc(d.headline)}</p>` : ''}
    ${d.location ? `<div class="pp-meta"><span>📍 ${esc(d.location)}</span></div>` : ''}
    ${badges ? `<div class="pp-badges">${badges}</div>` : ''}
    ${skills ? `<div class="pp-skills">${skills}</div>` : ''}
    ${shopUrl ? `<a class="pp-shop" href="${attr(shopUrl, 500)}">Visit shop @${esc(d.shop.handle)}</a>` : ''}
    <a class="pp-secondary" href="/">Explore SOKONI marketplace</a>
  </section>`;

  const reveal = `<script>
  /* Reveal the profile only to a signed-in visitor; everyone else keeps the gate.
     localStorage is the app's own login cache (set by firebase.js onAuthStateChanged);
     a genuine session is re-verified inside the app itself on any real action, so
     this reveal exposes nothing an account holder could not already see. */
  (function(){
    try {
      if (localStorage.getItem('loggedIn') === 'true' && localStorage.getItem('sokoniUser')) {
        var g = document.getElementById('ppGate'), p = document.getElementById('ppProfile');
        if (g) g.style.display = 'none';
        if (p) p.style.display = '';
      }
    } catch (e) {}
  })();
  </script>`;

  return _shell(meta, gate + profile + reveal);
}

/**
 * Honest failure page. Deliberately noindex, and deliberately empty of
 * invented member data — a page that fabricates a plausible profile to fill
 * the space is the worse outcome.
 */
function _profileErrorPage(heading, body) {
  const meta = metaBlock({
    title:       'SOKONI',
    description: "Kenya's unified marketplace.",
    image:       'https://mysokoni.co.ke/assets/logosokoni.png',
    url:         'https://mysokoni.co.ke',
    noindex:     true,
  });
  return _shell(meta, `<div class="pp-state">
    <h1>${esc(heading)}</h1>
    <p>${esc(body)}</p>
    <a class="pp-secondary" href="/">Explore SOKONI</a>
  </div>`);
}


module.exports = { renderProfilePage: _profilePage, renderProfileError: _profileErrorPage };
