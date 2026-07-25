/* ============================================================
   SOKONI Product Analytics & Trust Module  v1.0
   Populates all buyer-confidence UI on the product page.

   Usage (called from product.js after render):
     SokoniProductAnalytics.init(productId, sellerId, productData);

   Fills these placeholder elements:
     #prdAnalyticsBar      — views / sold / trending badges
     #prdPriceHistorySlot  — price history card with SVG chart
     #prdTrustPanel        — full buyer trust summary
     #prdSellerPerfSlot    — seller performance metrics
     #prdUrgencyBar        — real view + sold counts (already in DOM)
============================================================ */
(function (window) {
  'use strict';

  /* ── Firebase config (same as the rest of the platform) ── */
  var FB_CFG = {
    apiKey:            "AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE",
    authDomain: "auth.mysokoni.co.ke",
    projectId:         "sokoni-aeb26",
    storageBucket:     "sokoni-aeb26.firebasestorage.app",
    messagingSenderId: "24799054989",
    appId:             "1:24799054989:web:e1cf6ca8c281bf1abf26c4",
  };
  var CF_BASE = "https://us-central1-sokoni-aeb26.cloudfunctions.net";

  /* ── Session fingerprint (lives for one browser session only) ── */
  function _sessionFp() {
    var k = "_sk_fp";
    var fp = sessionStorage.getItem(k);
    if (!fp) {
      fp = Date.now().toString(36) + Math.random().toString(36).slice(2);
      sessionStorage.setItem(k, fp);
    }
    return fp;
  }

  /* ── Utility: relative time ── */
  function _timeAgo(ms) {
    if (!ms) return null;
    var diff = Date.now() - ms;
    var mins = Math.floor(diff / 60000);
    if (mins < 2)  return "just now";
    if (mins < 60) return mins + " minutes ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24)  return hrs + " hour" + (hrs > 1 ? "s" : "") + " ago";
    var days = Math.floor(hrs / 24);
    if (days === 1) return "yesterday";
    if (days < 7)  return days + " days ago";
    return new Date(ms).toLocaleDateString("en-KE", { day: "numeric", month: "short" });
  }

  /* ── Utility: format count ── */
  function _fmt(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  /* ── Utility: escape HTML ── */
  function _esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ── SVG price sparkline — no dependencies ── */
  function _sparkline(history) {
    if (!history || history.length < 2) return "";
    var prices = history.map(function(h) { return h.newPrice || h.price || 0; });
    var minP = Math.min.apply(null, prices);
    var maxP = Math.max.apply(null, prices);
    var range = maxP - minP || 1;
    var W = 260, H = 54, pad = 6;

    var pts = prices.map(function(p, i) {
      return {
        x: pad + (i / (prices.length - 1)) * (W - pad * 2),
        y: H - pad - ((p - minP) / range) * (H - pad * 2),
      };
    });

    var lineD = pts.map(function(p, i) {
      return (i === 0 ? "M" : "L") + p.x.toFixed(1) + "," + p.y.toFixed(1);
    }).join(" ");

    var fillD = lineD +
      " L" + pts[pts.length - 1].x.toFixed(1) + "," + H +
      " L" + pts[0].x.toFixed(1) + "," + H + " Z";

    /* Green if price dropped overall, red if increased */
    var isDown  = prices[prices.length - 1] <= prices[0];
    var stroke  = isDown ? "#71ff00" : "#ff4d4d";
    var fill    = isDown ? "rgba(113,255,0,0.07)" : "rgba(255,77,77,0.07)";
    var last    = pts[pts.length - 1];

    return [
      '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"',
      '  style="width:100%;height:' + H + 'px;display:block;overflow:visible;"',
      '  role="img" aria-label="Price trend chart">',
      '  <path d="' + fillD + '" fill="' + fill + '"/>',
      '  <path d="' + lineD + '" fill="none" stroke="' + stroke + '" stroke-width="2.5"',
      '    stroke-linecap="round" stroke-linejoin="round"/>',
      '  <circle cx="' + last.x.toFixed(1) + '" cy="' + last.y.toFixed(1) + '"',
      '    r="4.5" fill="' + stroke + '"/>',
      '</svg>',
    ].join("\n");
  }

  /* ── Call a Cloud Function ── */
  function _callCF(name, data) {
    return fetch(CF_BASE + "/" + name, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: data }),
    })
    .then(function(r) { return r.json(); })
    .then(function(j) { return j.result !== undefined ? j.result : j; });
  }

  /* ═══════════════════════════════════════════════════════════
     RENDER FUNCTIONS
  ═══════════════════════════════════════════════════════════ */

  /* ── Stat badges row ── */
  function _renderStatsBar(stats, el) {
    if (!el || !stats) return;
    var parts = [];

    /* Views today — only show if meaningful (≥ 10) */
    if (stats.viewsToday >= 10) {
      parts.push(
        '<span class="pt-badge pt-badge--views">' +
        '<span class="pt-badge-icon">👁️</span>' +
        '<span>' + _fmt(stats.viewsToday) + ' viewed today</span>' +
        '</span>'
      );
    } else if (stats.viewsWeek >= 20) {
      parts.push(
        '<span class="pt-badge pt-badge--views">' +
        '<span class="pt-badge-icon">👁️</span>' +
        '<span>' + _fmt(stats.viewsWeek) + ' views this week</span>' +
        '</span>'
      );
    }

    /* Sold count */
    if (stats.salesTotal > 0) {
      var soldLabel = stats.salesThisMonth > 0
        ? _fmt(stats.salesThisMonth) + " sold this month"
        : _fmt(stats.salesTotal) + " total sold";
      parts.push(
        '<span class="pt-badge pt-badge--sales">' +
        '<span class="pt-badge-icon">🛒</span>' +
        '<span>' + soldLabel + '</span>' +
        '</span>'
      );
    }

    /* Trending label */
    if (stats.trendingScore >= 30 && stats.trendingLabel) {
      parts.push(
        '<span class="pt-badge pt-badge--trending">' +
        '<span class="pt-badge-icon">🔥</span>' +
        '<span>' + _esc(stats.trendingLabel) + '</span>' +
        '</span>'
      );
    }

    /* Last purchased */
    if (stats.salesLastPurchasedAt) {
      var ago = _timeAgo(stats.salesLastPurchasedAt);
      if (ago) {
        parts.push(
          '<span class="pt-badge pt-badge--recent">' +
          '<span class="pt-badge-icon">⏱️</span>' +
          '<span>Last purchased ' + ago + '</span>' +
          '</span>'
        );
      }
    }

    if (parts.length === 0) return;
    el.innerHTML = '<div class="pt-stats-bar">' + parts.join("") + "</div>";
  }

  /* ── Urgency bar ── */
  function _renderUrgencyBar(stats) {
    var viewEl = document.getElementById("prdViewerCount");
    var soldEl = document.getElementById("prdSoldCount");
    var bar    = document.getElementById("prdUrgencyBar");
    if (!bar) return;

    var hasData = false;

    if (viewEl && stats && stats.viewsToday >= 10) {
      viewEl.textContent = _fmt(stats.viewsToday);
      hasData = true;
    }

    if (soldEl && stats && stats.salesTotal > 0) {
      var soldToday = stats.salesThisMonth > 0
        ? _fmt(stats.salesThisMonth) + " this month"
        : _fmt(stats.salesTotal);
      soldEl.textContent = soldToday;
      hasData = true;
    }

    /* Trend tag */
    var trendTag = document.getElementById("prdTrendingBadge");
    if (trendTag) {
      if (stats && stats.trendingScore >= 50 && stats.trendingLabel) {
        trendTag.innerHTML =
          '<span class="pt-trend-tag">🔥 ' + _esc(stats.trendingLabel) + '</span>';
      } else {
        trendTag.innerHTML = "";
      }
    }

    /* Hide the urgency bar if we have no real data (avoids showing dashes) */
    if (!hasData && bar) bar.style.display = "none";
  }

  /* ── Price History Module ── */
  function _renderPriceHistory(stats, history, el) {
    if (!el) return;

    /* No Firestore history — show last-updated date if we have it */
    if (!history || history.length === 0) {
      if (stats && stats.priceLastChangedAt) {
        var dt = new Date(stats.priceLastChangedAt);
        var dtStr = dt.toLocaleDateString("en-KE", { day: "2-digit", month: "2-digit", year: "numeric" });
        el.innerHTML =
          '<div class="pt-price-module pt-price-module--minimal">' +
          '<span class="pt-pm-label">Price last updated</span>' +
          '<span class="pt-pm-date">' + dtStr + '</span>' +
          '</div>';
      }
      return;
    }

    var curr    = stats ? (stats.priceCurrent || history[0].newPrice) : history[0].newPrice;
    var prev    = stats ? stats.pricePrevious : history[0].oldPrice;
    var low30   = stats ? stats.priceLowest30d  : null;
    var high30  = stats ? stats.priceHighest30d : null;
    var changed = stats ? stats.priceLastChangedAt : (history[0].changedAt || null);

    /* Build chart data (oldest first for left→right timeline) */
    var chartData = history.slice().reverse();
    var chart = _sparkline(chartData);

    var priceDiff  = prev != null ? curr - prev : null;
    var dirClass   = priceDiff != null ? (priceDiff < 0 ? "pt-pm-dir--down" : "pt-pm-dir--up") : "";
    var dirLabel   = priceDiff != null
      ? (priceDiff < 0 ? "▼ Price dropped" : "▲ Price increased")
      : "";
    var pctStr     = (priceDiff != null && prev)
      ? " " + Math.abs(Math.round((priceDiff / prev) * 100)) + "%"
      : "";

    /* Last 5 history items for the table */
    var tableRows = history.slice(0, 5).map(function(h) {
      var d = new Date(h.changedAt);
      var ds = d.toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "2-digit" });
      var arrow = h.newPrice < h.oldPrice ? "↓" : "↑";
      var cls   = h.newPrice < h.oldPrice ? "pt-ph-row--down" : "pt-ph-row--up";
      return [
        '<div class="pt-ph-row ' + cls + '">',
        '<span class="pt-ph-date">' + ds + '</span>',
        '<span class="pt-ph-arrow">' + arrow + '</span>',
        '<span class="pt-ph-prices">KES ' + Number(h.oldPrice).toLocaleString() +
          ' → KES ' + Number(h.newPrice).toLocaleString() + '</span>',
        (h.reason ? '<span class="pt-ph-reason">' + _esc(h.reason) + '</span>' : ''),
        '</div>',
      ].join("");
    }).join("");

    var html = [
      '<div class="pt-price-module">',
      '  <div class="pt-pm-header">',
      '    <span class="pt-pm-title">📈 Price History</span>',
      changed
        ? '<span class="pt-pm-updated">Updated ' + _timeAgo(changed) + '</span>'
        : '',
      '  </div>',

      '  <div class="pt-pm-chart">' + (chart || "") + '</div>',

      '  <div class="pt-pm-grid">',
      '    <div class="pt-pm-cell">',
      '      <div class="pt-pm-cell-label">Current</div>',
      '      <div class="pt-pm-cell-val">KES ' + Number(curr).toLocaleString() + '</div>',
      '    </div>',
      prev != null ? [
        '<div class="pt-pm-cell">',
        '  <div class="pt-pm-cell-label">Previous</div>',
        '  <div class="pt-pm-cell-val" style="text-decoration:line-through;opacity:.55;">',
        '    KES ' + Number(prev).toLocaleString(),
        '  </div>',
        '</div>',
      ].join("") : '',
      low30 != null ? [
        '<div class="pt-pm-cell">',
        '  <div class="pt-pm-cell-label">30-day Low</div>',
        '  <div class="pt-pm-cell-val pt-pm-cell-val--low">KES ' + Number(low30).toLocaleString() + '</div>',
        '</div>',
      ].join("") : '',
      high30 != null ? [
        '<div class="pt-pm-cell">',
        '  <div class="pt-pm-cell-label">30-day High</div>',
        '  <div class="pt-pm-cell-val pt-pm-cell-val--high">KES ' + Number(high30).toLocaleString() + '</div>',
        '</div>',
      ].join("") : '',
      '  </div>',

      priceDiff != null ? [
        '<div class="pt-pm-change ' + dirClass + '">',
        '  <span>' + dirLabel + pctStr + '</span>',
        '  <span class="pt-pm-change-abs">',
        '    KES ' + Math.abs(priceDiff).toLocaleString(),
        '  </span>',
        '</div>',
      ].join("") : '',

      tableRows
        ? '<div class="pt-ph-table">' + tableRows + '</div>'
        : '',

      '</div>',
    ].join("\n");

    el.innerHTML = html;
  }

  /* ── Seller Performance Card ── */
  function _renderSellerPerf(perf, el) {
    if (!el) return;
    if (!perf || perf.totalOrders < 5) {
      /* Not enough data to show — show "New Seller" placeholder */
      el.innerHTML =
        '<div class="pt-seller-perf pt-seller-perf--new">' +
        '<span class="pt-sp-icon">🌱</span>' +
        '<div class="pt-sp-text">' +
        '<span class="pt-sp-label">New Seller</span>' +
        '<span class="pt-sp-sub">Building their reputation on SOKONI</span>' +
        '</div></div>';
      return;
    }

    function _bar(pct, cls) {
      return '<div class="pt-sp-bar"><div class="pt-sp-bar-fill ' + (cls||"") + '" style="width:' + Math.min(100, pct) + '%"></div></div>';
    }

    var dispatch = perf.avgDispatchHours != null
      ? (perf.avgDispatchHours < 1 ? "< 1 hour"
          : perf.avgDispatchHours < 24 ? perf.avgDispatchHours.toFixed(1) + "h"
          : Math.round(perf.avgDispatchHours / 24) + " days")
      : null;

    var response = perf.avgResponseMinutes != null
      ? (perf.avgResponseMinutes < 60 ? perf.avgResponseMinutes + " min"
          : (perf.avgResponseMinutes / 60).toFixed(1) + "h")
      : null;

    var html = [
      '<div class="pt-seller-perf">',
      '  <div class="pt-sp-header">Seller Performance</div>',
      '  <div class="pt-sp-grid">',

      '    <div class="pt-sp-item">',
      '      <div class="pt-sp-item-top">',
      '        <span class="pt-sp-item-label">Order Fulfillment</span>',
      '        <span class="pt-sp-item-val ' + (perf.fulfillmentRate >= 95 ? "pt-val--great" : perf.fulfillmentRate >= 80 ? "pt-val--ok" : "pt-val--warn") + '">' + perf.fulfillmentRate + '%</span>',
      '      </div>',
      _bar(perf.fulfillmentRate, perf.fulfillmentRate >= 95 ? "pt-sp-bar-fill--great" : ""),
      '    </div>',

      perf.cancellationRate > 0 ? [
        '<div class="pt-sp-item">',
        '  <div class="pt-sp-item-top">',
        '    <span class="pt-sp-item-label">Cancellation Rate</span>',
        '    <span class="pt-sp-item-val ' + (perf.cancellationRate <= 3 ? "pt-val--great" : "pt-val--warn") + '">' + perf.cancellationRate + '%</span>',
        '  </div>',
        _bar(perf.cancellationRate, "pt-sp-bar-fill--warn"),
        '</div>',
      ].join("") : '',

      dispatch ? [
        '<div class="pt-sp-item pt-sp-item--stat">',
        '  <span class="pt-sp-item-label">Avg Dispatch Time</span>',
        '  <span class="pt-sp-item-val">' + dispatch + '</span>',
        '</div>',
      ].join("") : '',

      response ? [
        '<div class="pt-sp-item pt-sp-item--stat">',
        '  <span class="pt-sp-item-label">Response Time</span>',
        '  <span class="pt-sp-item-val">' + response + '</span>',
        '</div>',
      ].join("") : '',

      '    <div class="pt-sp-item pt-sp-item--stat">',
      '      <span class="pt-sp-item-label">Completed Orders</span>',
      '      <span class="pt-sp-item-val">' + _fmt(perf.successfulOrders || perf.totalOrders) + '</span>',
      '    </div>',

      perf.avgRating ? [
        '<div class="pt-sp-item pt-sp-item--stat">',
        '  <span class="pt-sp-item-label">Average Rating</span>',
        '  <span class="pt-sp-item-val pt-val--great">★ ' + (perf.avgRating).toFixed(1) + '</span>',
        '</div>',
      ].join("") : '',

      '  </div>',
      '</div>',
    ].join("\n");

    el.innerHTML = html;
  }

  /* ── Buyer Trust Panel ── */
  function _renderTrustPanel(stats, perf, product, el) {
    if (!el) return;

    var isVerified = product && (product.sellerVerified || false);
    var hasRating  = perf && perf.avgRating != null;

    /* Seller tenure from product data */
    var joinedStr = null;
    if (product && product.sellerJoined) {
      var yr = new Date(product.sellerJoined).getFullYear();
      joinedStr = "Member since " + yr;
    }

    function _cell(icon, label, value, cls) {
      return [
        '<div class="pt-trust-cell' + (cls ? " " + cls : "") + '">',
        '  <span class="pt-trust-icon">' + icon + '</span>',
        '  <div class="pt-trust-info">',
        '    <span class="pt-trust-label">' + label + '</span>',
        '    <span class="pt-trust-value">' + _esc(value) + '</span>',
        '  </div>',
        '</div>',
      ].join("");
    }

    var fulfillmentStr = perf && perf.fulfillmentRate
      ? perf.fulfillmentRate + "% Fulfillment"
      : (stats && stats.salesTotal >= 10 ? "Active Seller" : "New Seller");

    var salesStr = stats && stats.salesTotal > 0
      ? _fmt(stats.salesTotal) + " successful orders"
      : "New listing";

    var ratingStr = perf && hasRating
      ? "★ " + (perf.avgRating).toFixed(1) + " (" + _fmt(perf.totalRatings || 0) + " reviews)"
      : "No ratings yet";

    var html = [
      '<div class="pt-trust-panel">',
      '  <div class="pt-trust-header">',
      '    <span class="pt-trust-title">🛡️ Buyer Trust Summary</span>',
      '  </div>',
      '  <div class="pt-trust-grid">',
      isVerified ? _cell("✅", "Verified Seller", "Identity verified", "pt-trust-cell--verified") : '',
      _cell("🔒", "Secure Payment", "256-bit encrypted", "pt-trust-cell--secure"),
      _cell("🛡️", "Buyer Protection", "Dispute resolution", ""),
      _cell("📦", "Order Tracking", "Real-time delivery updates", ""),
      _cell("🔄", "Return Policy", product && product.returnPolicy ? product.returnPolicy : "Seller's policy", ""),
      _cell("⭐", "Rating", ratingStr, hasRating && perf.avgRating >= 4.5 ? "pt-trust-cell--great" : ""),
      _cell("📊", "Performance", fulfillmentStr, ""),
      _cell("🛒", "Sales Record", salesStr, ""),
      joinedStr ? _cell("📅", "Seller Tenure", joinedStr, "") : '',
      '  </div>',
      '  <div class="pt-trust-footer">',
      '    <span>All data reflects real SOKONI marketplace activity</span>',
      '  </div>',
      '</div>',
    ].join("\n");

    el.innerHTML = html;
  }

  /* ═══════════════════════════════════════════════════════════
     INIT — main entry point
  ═══════════════════════════════════════════════════════════ */
  function init(productId, sellerId, productData) {
    if (!productId) return;

    /* Show skeleton loaders in all slots */
    _showSkeletons();

    /* Record the view (non-blocking, best-effort) */
    var city = null;
    try { city = (productData && (productData.location || productData.county)) || null; } catch (_) {}
    _recordView(productId, sellerId, city);

    /* Load trust data and render */
    _callCF("getProductTrustData", { productId: productId, sellerId: sellerId || null })
      .then(function(result) {
        var stats   = (result && result.stats)      || null;
        var history = (result && result.priceHistory) || [];
        var perf    = (result && result.sellerPerf)  || null;

        _renderUrgencyBar(stats);
        _renderStatsBar(stats, document.getElementById("prdAnalyticsBar"));
        _renderPriceHistory(stats, history, document.getElementById("prdPriceHistorySlot"));
        _renderSellerPerf(perf, document.getElementById("prdSellerPerfSlot"));
        _renderTrustPanel(stats, perf, productData, document.getElementById("prdTrustPanel"));
      })
      .catch(function(err) {
        console.warn("[SokoniProductAnalytics] Trust data load failed:", err && err.message);
        /* Clear skeletons on error — avoid broken UI */
        var slots = ["prdAnalyticsBar", "prdPriceHistorySlot", "prdSellerPerfSlot", "prdTrustPanel"];
        slots.forEach(function(id) {
          var el = document.getElementById(id);
          if (el) el.innerHTML = "";
        });
        /* Also clear urgency bar on failure */
        var bar = document.getElementById("prdUrgencyBar");
        if (bar) bar.style.display = "none";
      });
  }

  /* ── Record view via CF ── */
  function _recordView(productId, sellerId, city) {
    /* Only fire once per session per product */
    var sessionKey = "_sk_vd_" + productId;
    if (sessionStorage.getItem(sessionKey)) return;
    sessionStorage.setItem(sessionKey, "1");

    _callCF("recordProductView", {
      productId:  productId,
      sellerId:   sellerId || null,
      city:       city || null,
      sessionFp:  _sessionFp(),
    }).catch(function() { /* non-critical */ });
  }

  /* ── Skeleton loaders ── */
  function _showSkeletons() {
    var skel = '<div class="pt-skeleton"></div>';
    var ids  = ["prdAnalyticsBar", "prdPriceHistorySlot", "prdSellerPerfSlot", "prdTrustPanel"];
    ids.forEach(function(id) {
      var el = document.getElementById(id);
      if (el && el.innerHTML.trim() === "") el.innerHTML = skel;
    });
  }

  /* ── Public API ── */
  window.SokoniProductAnalytics = { init: init };

}(window));
