'use strict';

/**
 * SOKONI HTML Render Helpers v1.0
 *
 * Shared utilities for the functions that serve HTML directly — the
 * prerendered public pages behind /profile/{uid} and /shop/{handle}.
 *
 * Why these exist at all: hosting is static, so a link preview crawler
 * (WhatsApp, Slack, Twitter, Facebook) sees whatever OG tags are baked into
 * the file. Every shop and every member therefore previewed identically, and
 * a shared link looked generic at best and — for /profile — looked like the
 * sharer's own dashboard. Per-entity previews require the HTML to vary per
 * request, which means a function in the path.
 *
 * SECURITY: everything here treats its input as hostile. All of it originates
 * from user-controlled Firestore documents (display names, shop names, bios)
 * and is being written into markup, which is the exact shape of a stored XSS.
 * Never interpolate a raw value into HTML anywhere in this codebase — route it
 * through `esc` for text, `attr` for attribute values, and `httpsUrl` for
 * anything that lands in href/src/content.
 */

/**
 * Escape the five characters that can break out of HTML text or a quoted
 * attribute value. Also neutralises `/` so a value can never close a tag
 * early when it is written inside one.
 */
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape for use inside a double-quoted attribute, and collapse newlines.
 * A raw newline in a meta content attribute truncates the preview on some
 * crawlers, so this is correctness as well as safety.
 */
function attr(v, max = 300) {
  return esc(String(v === null || v === undefined ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max));
}

/**
 * Return `u` only if it is an absolute https URL, else null.
 *
 * This is what stops `javascript:`, `data:` and protocol-relative values from
 * reaching an href, src or og:image. Relative paths are rejected outright
 * because every caller here builds absolute URLs.
 */
function httpsUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' ? p.href : null;
  } catch (_) {
    return null;
  }
}

/**
 * Build the full block of preview metadata for a page: title, description,
 * canonical, Open Graph and Twitter Card.
 *
 * `image` must already be an absolute https URL — pass it through httpsUrl
 * first. Crawlers reject relative og:image values.
 */
function metaBlock({ title, description, image, url, type = 'website', siteName = 'SOKONI', noindex = false }) {
  const t = attr(title, 120);
  const d = attr(description, 280);
  const i = httpsUrl(image) || 'https://mysokoni.co.ke/assets/logosokoni.png';
  const u = httpsUrl(url) || 'https://mysokoni.co.ke';

  return [
    `<title>${esc(title).slice(0, 200)}</title>`,
    `<meta name="description" content="${d}">`,
    noindex ? '<meta name="robots" content="noindex, nofollow">' : '<meta name="robots" content="index, follow">',
    `<link rel="canonical" href="${attr(u, 500)}">`,
    `<meta property="og:type" content="${attr(type, 40)}">`,
    `<meta property="og:site_name" content="${attr(siteName, 60)}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:image" content="${attr(i, 500)}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:url" content="${attr(u, 500)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${attr(i, 500)}">`,
  ].join('\n  ');
}

/* Tags this module owns. Any of these already present in a template must be
   removed before injection, or the crawler sees two og:title values and picks
   whichever it likes — usually the stale static one, which is the bug. */
const OWNED_TAG = /<title>[\s\S]*?<\/title>|<meta[^>]+(?:property=["'](?:og|article|profile):[^"']*["']|name=["'](?:description|robots|twitter:[^"']*)["'])[^>]*>|<link[^>]+rel=["']canonical["'][^>]*>/gi;

/**
 * Replace a static template's preview metadata with per-entity metadata.
 *
 * Strips every tag this module owns, then injects the new block immediately
 * before </head>. If the template has no </head> the original is returned
 * untouched — serving a page with a stale preview is strictly better than
 * serving a corrupted one.
 */
function injectMeta(html, block) {
  if (typeof html !== 'string' || !html) return html;
  const closeHead = html.search(/<\/head\s*>/i);
  if (closeHead === -1) return html;

  const head = html.slice(0, closeHead).replace(OWNED_TAG, '');
  return head + '  ' + block + '\n' + html.slice(closeHead);
}

/* ── Template cache ────────────────────────────────────────────────────────
   The static templates live on Hosting, not in the functions bundle. Copying
   them into functions/ would create a second copy that silently drifts from
   the page people actually edit, so they are fetched over HTTP instead and
   held in module memory for the life of the instance.

   The TTL matters: without it a warm instance would keep serving the previous
   deploy's markup indefinitely after a hosting release.
──────────────────────────────────────────────────────────────────────────── */
const _templates = new Map();
const TEMPLATE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch a static template from Hosting, memoised per instance.
 * Returns null on failure — callers must handle that rather than serving
 * a broken page.
 */
async function fetchTemplate(url, { ttlMs = TEMPLATE_TTL_MS, timeoutMs = 4000, now = Date.now() } = {}) {
  const hit = _templates.get(url);
  if (hit && now - hit.at < ttlMs) return hit.html;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal });
    if (!res.ok) throw new Error('template_http_' + res.status);
    const html = await res.text();
    if (!html || html.length < 200) throw new Error('template_too_small');
    _templates.set(url, { html, at: now });
    return html;
  } catch (_) {
    /* Serve a stale copy rather than nothing — an expired template still
       renders the page correctly, it only risks an out-of-date asset hash. */
    return hit ? hit.html : null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { esc, attr, httpsUrl, metaBlock, injectMeta, fetchTemplate, OWNED_TAG };
