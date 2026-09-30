'use strict';

/**
 * SOKONI MiniShop Page Prerender v1.0
 *
 * Serves /shop/{handle} and /@{handle}.
 *
 * Why this exists: those paths used to rewrite straight to the static
 * minishop.html, so every shop on the platform shared the same link preview —
 * "Shop on SOKONI", with the SOKONI logo. Sellers share these links constantly
 * on WhatsApp, and a preview that does not name the shop or show its logo is
 * the difference between a tap and a scroll past. Link preview crawlers do not
 * run JavaScript, so the only way for the card to differ per shop is for the
 * HTML to differ per request.
 *
 * What it does NOT do: re-implement the storefront. The page is still rendered
 * client-side by sokoni-minishop.js exactly as before. This function fetches
 * the same static template and swaps the preview metadata in the <head>. That
 * keeps one copy of the storefront markup — the file sellers' UI is actually
 * built from — rather than a second copy inside the functions bundle that
 * would drift.
 *
 * Failure policy is fail-open, in three stages: bad metadata is better than no
 * page, and no page is the only unacceptable outcome. See _fallback below.
 */

const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getFirestore } = require('firebase-admin/firestore');
const admin = require('firebase-admin');
const { httpsUrl, metaBlock, injectMeta, fetchTemplate } = require('./html-render');
const { resolve: resolveConfig } = require('./minishop-config-schema');

if (!admin.apps.length) admin.initializeApp();

const REGION   = 'us-central1';
const ORIGIN   = 'https://mysokoni.co.ke';
const TEMPLATE = `${ORIGIN}/minishop.html`;

const _db = () => getFirestore();

/** Matches the handle grammar enforced by claimMinishopHandle. */
const HANDLE_RE = /^[a-z0-9_-]{1,30}$/;

/**
 * Pull the handle out of /shop/{handle}, /@{handle} or ?handle=.
 * Returns '' when the path does not carry a usable handle.
 */
function _parseHandle(req) {
  const path = req.path || '';
  let m = path.match(/^\/shop\/([^/?#]+)/) || path.match(/^\/@([^/?#]+)/);
  let raw = m ? m[1] : String(req.query.handle || '');
  try { raw = decodeURIComponent(raw); } catch (_) { /* keep raw */ }
  raw = raw.replace(/^@/, '').toLowerCase().trim();
  return HANDLE_RE.test(raw) ? raw : '';
}

/**
 * Last-resort response. If the template could not be fetched we cannot serve
 * the storefront markup at all, so hand the browser to the static page with
 * the handle in the query string — sokoni-minishop.js reads ?handle= as a
 * fallback, so the shop still loads. The URL changes, which is a real cost,
 * but a working storefront at a uglier URL beats an error page.
 */
function _fallback(res, handle) {
  res.set('Cache-Control', 'no-store');
  res.redirect(302, handle ? `/minishop?handle=${encodeURIComponent(handle)}` : '/');
}

exports.minishopPage = onRequest(
  /* minInstances: 1 — this function is now in front of the storefront, the
     most commercially important public page on the platform. A cold start
     here is a seller's shared link appearing to hang. This is the price of
     per-shop previews and it is not optional. */
  { region: REGION, cors: false, minInstances: 1, memory: '256MiB' },
  async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).send('Method not allowed.');
      return;
    }

    const handle = _parseHandle(req);
    res.set('Vary', 'Accept-Encoding');

    /* The template is needed for every outcome below, and a shop read is
       useless without it, so both start together. */
    const templateP = fetchTemplate(TEMPLATE);

    if (!handle) {
      const html = await templateP;
      if (!html) { _fallback(res, ''); return; }
      res.set('Cache-Control', 'public, max-age=300');
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.status(404).send(injectMeta(html, metaBlock({
        title:       'Shop not found — SOKONI',
        description: 'This shop link is not valid.',
        image:       `${ORIGIN}/assets/logosokoni.png`,
        url:         ORIGIN,
        noindex:     true,
      })));
      return;
    }

    let meta = null;
    let status = 200;

    try {
      const db = _db();
      const handleSnap = await db.collection('shopHandles').doc(handle).get();

      if (!handleSnap.exists) {
        status = 404;
        meta = metaBlock({
          title:       'Shop not found — SOKONI',
          description: 'This shop is no longer available on SOKONI.',
          image:       `${ORIGIN}/assets/logosokoni.png`,
          url:         `${ORIGIN}/shop/${handle}`,
          noindex:     true,
        });
      } else {
        const { shopId } = handleSnap.data();
        const [shopSnap, configSnap] = await Promise.all([
          db.collection('shops').doc(shopId).get(),
          db.collection('minishopConfig').doc(shopId).get().catch(() => null),
        ]);

        const shop = shopSnap.exists ? shopSnap.data() : {};

        /* Branding is resolved through the shared schema module rather than read
           straight off one document. MiniShop config was historically split
           across two stores with two key schemes, so reading only the canonical
           one would leave most shared links falling back to the SOKONI logo —
           the exact defect this function exists to fix. */
        const config = resolveConfig(
          configSnap?.exists ? configSnap.data() : {},
          shop.minishopConfig,
          shop
        );

        const name = shop.name || shop.shopName || shop.businessName || `@${handle}`;

        /* Prefer what the seller wrote about their own shop; fall back to
           something specific enough to still be worth tapping. */
        const description = config.description || config.tagline ||
          `Shop directly from ${name} on SOKONI — Kenya's marketplace. Order on WhatsApp or pay with M-Pesa.`;

        /* The preview image is the single biggest driver of whether a shared
           link gets opened, so the shop's own cover or logo is used when it
           has one. */
        const image = httpsUrl(config.coverUrl) || httpsUrl(config.logoUrl) ||
                      `${ORIGIN}/assets/logosokoni.png`;

        meta = metaBlock({
          title:       `${name} — SOKONI`,
          description,
          image,
          url:         `${ORIGIN}/shop/${handle}`,
          type:        'website',
        });
      }
    } catch (err) {
      /* Stage two of fail-open: the shop read failed, but the template may
         still be fine. Serve the storefront with generic metadata and let the
         client-side fetch surface any real error to the visitor. */
      logger.error('[minishop-page] shop read failed', { handle, err: err.message });
      meta = null;
    }

    const html = await templateP;
    if (!html) { _fallback(res, handle); return; }

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', meta && status === 200
      ? 'public, max-age=300, s-maxage=600, stale-while-revalidate=86400'
      : 'no-store');

    /* MS_HANDLE is the hook sokoni-minishop.js checks before it parses the
       path, so setting it here saves the client that work and keeps the page
       correct even if the URL shape changes later. */
    const boot = `<script>window.MS_HANDLE=${JSON.stringify(handle)};</script>`;

    res.status(status).send(meta ? injectMeta(html, meta + '\n  ' + boot) : injectMeta(html, boot));
  }
);
