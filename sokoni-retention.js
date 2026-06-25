/* ============================================================
   SokoniRetention  v1.0
   Frontend retention service: recently viewed, saved searches,
   price alerts. localStorage-first with Firestore sync for
   authenticated users.

   Usage:
     SokoniRetention.trackView({ productId, name, price, image, category })
     SokoniRetention.getRecentlyViewed()          → array[20]
     SokoniRetention.saveSearch(query)            → Promise
     SokoniRetention.createPriceAlert(opts)       → Promise
     SokoniRetention.renderRecentlyViewed(elId)   → injects HTML into element
============================================================ */
(function(global) {
  "use strict";

  const LS_RECENT  = "sokoni_recently_viewed";
  const MAX_LOCAL  = 20;

  /* ── localStorage helpers ─────────────────────────────────── */
  function _readLocal(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
  }
  function _writeLocal(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  /* ── Firebase lazy loader ─────────────────────────────────── */
  let _fnsPromise = null;
  async function _getFns() {
    if (_fnsPromise) return _fnsPromise;
    _fnsPromise = import("https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js")
      .then(m => m.getFunctions(undefined, "us-central1"));
    return _fnsPromise;
  }
  async function _call(name, data) {
    const { httpsCallable } = await import("https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js");
    const fns = await _getFns();
    return httpsCallable(fns, name)(data);
  }

  /* ── Escape helper ────────────────────────────────────────── */
  function _esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ══════════════════════════════════════════════════════════
     trackView
     Call on every product page load. Dedupes by productId,
     stores in localStorage immediately, syncs to Firestore
     in the background for logged-in users.
  ══════════════════════════════════════════════════════════ */
  function trackView({ productId, name, price, image, category } = {}) {
    if (!productId) return;

    const items  = _readLocal(LS_RECENT, []);
    const entry  = { productId, name: (name||"").slice(0,120), price: parseFloat(price)||0,
                     image: (image||"").slice(0,500), category: category||"", viewedAt: Date.now() };

    /* Remove any existing entry for this product, prepend new */
    const filtered = items.filter(i => i.productId !== productId);
    filtered.unshift(entry);
    if (filtered.length > MAX_LOCAL) filtered.length = MAX_LOCAL;
    _writeLocal(LS_RECENT, filtered);

    /* Async Firestore sync — non-blocking */
    _call("recordRecentlyViewed", { productId, name: entry.name, price: entry.price,
      image: entry.image, category: entry.category }).catch(() => {});
  }

  /* ══════════════════════════════════════════════════════════
     getRecentlyViewed
     Returns the local recently-viewed array (up to 20 items).
  ══════════════════════════════════════════════════════════ */
  function getRecentlyViewed() {
    return _readLocal(LS_RECENT, []);
  }

  /* ══════════════════════════════════════════════════════════
     renderRecentlyViewed
     Injects a horizontally-scrolling product strip into the
     element matching elId. Shows nothing if < 2 items.
  ══════════════════════════════════════════════════════════ */
  function renderRecentlyViewed(elId) {
    const items = getRecentlyViewed();
    const el    = document.getElementById(elId);
    if (!el || items.length < 2) { if (el) el.style.display = "none"; return; }

    el.style.display = "block";
    el.innerHTML = `
      <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;
                  color:rgba(255,255,255,.35);margin-bottom:12px">Recently Viewed</div>
      <div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none">
        ${items.map(p => `
          <a href="product.html?id=${_esc(p.productId)}" style="text-decoration:none;flex-shrink:0;width:100px">
            <div style="width:100px;height:100px;border-radius:10px;overflow:hidden;
                        background:rgba(255,255,255,.05);margin-bottom:6px">
              ${p.image
                ? `<img src="${_esc(p.image)}" alt="" style="width:100%;height:100%;object-fit:cover" loading="lazy">`
                : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;
                               font-size:28px;color:rgba(255,255,255,.2)">📦</div>`}
            </div>
            <div style="font-size:11px;font-weight:700;color:#fff;white-space:nowrap;
                        overflow:hidden;text-overflow:ellipsis">${_esc(p.name)}</div>
            ${p.price ? `<div style="font-size:11px;color:#71ff00;font-weight:800">
                           KES ${Number(p.price).toLocaleString()}</div>` : ""}
          </a>`).join("")}
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════
     saveSearch
     Persists a search query for logged-in users.
     Returns promise resolving to { id, duplicate }.
  ══════════════════════════════════════════════════════════ */
  async function saveSearch(query) {
    const { data } = await _call("saveSearch", { query });
    return data;
  }

  /* ══════════════════════════════════════════════════════════
     deleteSavedSearch
  ══════════════════════════════════════════════════════════ */
  async function deleteSavedSearch(id) {
    const { data } = await _call("deleteSavedSearch", { id });
    return data;
  }

  /* ══════════════════════════════════════════════════════════
     createPriceAlert
     opts: { productId, productName, currentPrice, targetPrice }
  ══════════════════════════════════════════════════════════ */
  async function createPriceAlert(opts) {
    const { data } = await _call("createPriceAlert", opts);
    return data;
  }

  /* ══════════════════════════════════════════════════════════
     deletePriceAlert
  ══════════════════════════════════════════════════════════ */
  async function deletePriceAlert(id) {
    const { data } = await _call("deletePriceAlert", { id });
    return data;
  }

  /* ══════════════════════════════════════════════════════════
     getRetentionData
     Returns { recentlyViewed, savedSearches, priceAlerts }
     from Firestore (logged-in users only).
  ══════════════════════════════════════════════════════════ */
  async function getRetentionData() {
    const { data } = await _call("getRetentionData", {});
    return data;
  }

  /* ══════════════════════════════════════════════════════════
     Auto-inject recently-viewed strip on compatible pages.
     Pages that want the strip should include a div with
     id="recently-viewed-strip".
  ══════════════════════════════════════════════════════════ */
  function _autoRender() {
    if (document.getElementById("recently-viewed-strip")) {
      renderRecentlyViewed("recently-viewed-strip");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _autoRender);
  } else {
    _autoRender();
  }

  /* ── Public API ─────────────────────────────────────────── */
  global.SokoniRetention = {
    trackView,
    getRecentlyViewed,
    renderRecentlyViewed,
    saveSearch,
    deleteSavedSearch,
    createPriceAlert,
    deletePriceAlert,
    getRetentionData,
  };

})(window);
