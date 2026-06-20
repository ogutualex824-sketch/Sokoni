/*
 * SOKONI — Browser-Sync Live Reload Config
 *
 * Start with:  npm run dev
 *
 * You get two URLs:
 *   Local   → http://localhost:3000        (this PC)
 *   Network → http://192.168.x.x:3000      (phones + other devices on same WiFi)
 *
 * Edit any HTML / CSS / JS → every connected device refreshes instantly.
 * CSS-only edits inject without a full page reload (no flicker).
 */

module.exports = {
  /* ── Server ── */
  server: {
    baseDir: ".",
    index:   "index.html",
    /* Serve .html files without the extension so /entertainment works */
    serveStaticOptions: { extensions: ["html"] }
  },

  /* ── Files to watch ── */
  files: [
    "**/*.html",
    "**/*.css",
    "**/*.js",
    /* Ignore files that don't affect the browser */
    "!node_modules/**",
    "!Temp/**",
    "!.firebase/**",
    "!.git/**",
    "!bs-config.js",
    "!package.json",
    "!package-lock.json",
    "!firebase.json",
    "!firestore.rules",
    "!firestore.indexes.json",
    "!service-worker.js"   /* SW changes are handled separately */
  ],

  /* ── Port ── */
  port: 3000,

  /* ── Behaviour ── */
  open:          "local",   /* auto-opens localhost in your default browser */
  notify:        true,      /* small overlay shows "Connected" on reload     */
  injectChanges: true,      /* CSS-only edits inject live — no full reload    */
  reloadDelay:   100,       /* brief pause so the file write completes first  */
  reloadDebounce: 400,      /* prevents double-reload on bulk saves           */

  /* ── Browser-Sync UI (admin panel at :3001) ── */
  ui: {
    port: 3001
  },

  /* ── CORS: allow phones to connect ── */
  cors: true,

  /* ── Ghost Mode: sync clicks, scrolls, forms across all devices ── */
  ghostMode: {
    clicks: false,   /* set true to mirror clicks on all devices */
    scroll: false,
    forms:  false
  }
};
