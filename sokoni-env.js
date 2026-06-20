/* ================================================================
   SOKONI — Runtime Environment Configuration  (sokoni-env.js)
   Detects the current environment and exposes the correct
   configuration constants to all pages.

   Environments:
     development  — localhost / 127.0.0.1 / *.local
     staging      — sokoni-staging.web.app / staging.mysokoni.co.ke
     production   — mysokoni.co.ke / sokoni-aeb26.web.app / sokoni-aeb26.firebaseapp.com
================================================================ */
(function () {
  "use strict";

  const host = location.hostname;

  /* ── Environment detection ─────────────────────────────────── */
  const ENV =
    (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local"))
      ? "development"
    : (host.includes("staging") || host.includes("-staging"))
      ? "staging"
      : "production";

  /* ── Per-environment constants ─────────────────────────────── */
  const CONFIGS = {
    development: {
      env:           "development",
      label:         "DEV",
      debug:         true,
      intasendSandbox: true,
      cfRegion:      "us-central1",
      projectId:     "sokoni-aeb26",
      siteUrl:       "http://localhost:3000",
      logLevel:      "verbose",
      analyticsEnabled: false,
    },
    staging: {
      env:           "staging",
      label:         "STAGING",
      debug:         true,
      intasendSandbox: true,            // staging always uses IntaSend sandbox
      cfRegion:      "us-central1",
      projectId:     "sokoni-aeb26",    // replace with staging project ID when created
      siteUrl:       "https://sokoni-staging.web.app",
      logLevel:      "info",
      analyticsEnabled: false,
    },
    production: {
      env:           "production",
      label:         "",
      debug:         false,
      intasendSandbox: false,
      cfRegion:      "us-central1",
      projectId:     "sokoni-aeb26",
      siteUrl:       "https://mysokoni.co.ke",
      logLevel:      "error",
      analyticsEnabled: true,
    },
  };

  const cfg = CONFIGS[ENV];

  /* ── Expose globally ───────────────────────────────────────── */
  window.SOKONI_ENV = cfg;

  /* ── Override SOKONI_CONFIG.intasendLive to match env ─────── */
  if (window.SOKONI_CONFIG) {
    window.SOKONI_CONFIG.intasendLive = !cfg.intasendSandbox;
  } else {
    /* Queue the override until sokoni-config.js loads */
    document.addEventListener("sokoniConfigReady", function () {
      if (window.SOKONI_CONFIG) window.SOKONI_CONFIG.intasendLive = !cfg.intasendSandbox;
    }, { once: true });
  }

  /* ── Dev-mode banner ───────────────────────────────────────── */
  if (cfg.debug && cfg.label) {
    document.addEventListener("DOMContentLoaded", function () {
      if (document.getElementById("_sokoniEnvBanner")) return;
      const bar       = document.createElement("div");
      bar.id          = "_sokoniEnvBanner";
      bar.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:99999;background:#b91c1c;" +
        "color:#fff;text-align:center;font-size:11px;font-weight:700;padding:3px 0;" +
        "letter-spacing:.05em;pointer-events:none;";
      bar.textContent = "⚠️ " + cfg.label + " — IntaSend SANDBOX — no real money";
      document.body.appendChild(bar);
    });
  }

  /* ── Log suppression in production ────────────────────────── */
  if (ENV === "production") {
    const _noop = () => {};
    window.console.debug = _noop;
    /* Preserve console.warn and console.error for crash reporting */
  }
}());
