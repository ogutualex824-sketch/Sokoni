/* ============================================================================
   SOKONI Integrations Control Center — sokoni-integrations.js   v1.0.0
   ============================================================================
   ONE integrations surface, mounted by BOTH platform-admin consoles:

     admin-os.html    → panel "integrations"  (claims.admin)
     super-admin.html → panel "integrations"  (claims.superAdmin)

   admin.html is deliberately NOT a consumer (owner ruling, 2026-09-19).

   WHY A SHARED MODULE RATHER THAN A PANEL PER CONSOLE
   ---------------------------------------------------
   SOKONI is flat multi-page HTML with no router and no build step. Two consoles
   rendering the same registry from two hand-written copies is how surfaces
   diverge — the merchant estate already paid that bill. One module, two mount
   points: a change to how an integration is judged healthy lands in both
   consoles at once, or in neither.

   DATA AUTHORITY — READ THIS BEFORE ADDING A NUMBER
   -------------------------------------------------
   Every figure on this surface comes from a canonical Firestore collection and
   nothing else. There is no client-side arithmetic over prices, no localStorage
   fallback, no seed data, no "looks about right" multiplier.

     platformServices/{serviceId}      a SELF-REGISTRATION LOG, not an inventory (RC-2)
     platformHealth/{serviceId}        the latest heartbeat — how it is doing
     platformDependencies/{from→to}    declared edges between services
     posWebhooks/{webhookId}           merchant-registered webhook endpoints

   All four are `allow read: if isAdmin()` (firestore.rules). This console
   therefore needs NO Cloud Function deploy and NO rules change — which matters
   while the Artifact Registry forensics freeze stands (see CLAUDE.md).

   UNKNOWN IS NOT ZERO
   -------------------
   A read that FAILS renders an em dash and says the source is unavailable. A
   read that SUCCEEDS and returns nothing renders a real, canonical zero and
   says so. Those two states look different on purpose: the difference between
   "no integration is unhealthy" and "we could not find out" is the whole point
   of an operations console.

   A service with no platformHealth document has status "unknown" — never
   "healthy". Absence of a heartbeat is absence of evidence.

   STALENESS MIRRORS THE SERVER
   ----------------------------
   platformGetHealth (functions/platform-registry.js) marks a heartbeat stale at
   300000 ms. STALE_MS below is that same threshold. If the server's threshold
   moves, move this one in the same commit, or the console and the API will
   disagree about the same service.

   SECRETS
   -------
   posWebhooks documents carry a `secret` used to sign outbound payloads. An
   admin can read it; this console never renders it, never copies it and never
   puts it in the DOM. WEBHOOK_SAFE_FIELDS is an allow-list, not a deny-list, so
   a field added to that collection later cannot leak here by default.

   READ-ONLY BY CONSTRUCTION
   -------------------------
   This surface performs no writes. Deregistering a service, rotating a webhook
   secret and pausing an integration are privileged mutations that belong behind
   an audited callable with a confirm gate; none is wired here. Do not add a
   write path without an audit record and a second-person confirmation.

   USAGE
     <script src="/sokoni-integrations.js"></script>
     SokoniIntegrations.mount('integrationsRoot');   // renders + loads
     SokoniIntegrations.refresh();                   // re-reads every source
   ========================================================================== */
(function () {
  'use strict';

  /* ── Contract constants ──────────────────────────────────────────────── */

  /* Mirrors platformGetHealth's stale threshold. Keep both in one commit. */
  var STALE_MS = 300000;

  /* Mirrors PLATFORM_CAPABILITIES in functions/platform-registry.js. Used only
     to mark a declared capability as well-known vs ad hoc — never to invent a
     consumer count. Counts always come from the registry documents. */
  var WELL_KNOWN_CAPABILITIES = [
    'authentication', 'rbac', 'abac', 'subscriptions', 'entitlements',
    'billing', 'payments', 'escrow', 'ledger', 'commission', 'tax',
    'notifications', 'ai_platform', 'ai_credits', 'fraud_detection',
    'risk_engine', 'search', 'workflow_automation', 'storage', 'usage_metering',
    'analytics', 'audit_logs', 'monitoring', 'logging', 'feature_flags',
    'configuration', 'api_gateway', 'event_bus', 'queue_system',
    'secrets_management', 'device_trust', 'geo_intelligence', 'media',
  ];

  /* Allow-list for posWebhooks rendering. `secret` is absent BY DESIGN. */
  var WEBHOOK_SAFE_FIELDS = [
    'id', 'sellerId', 'url', 'events', 'description', 'active',
    'failureCount', 'lastFiredAt', 'lastStatus', 'createdAt', 'revokedAt',
  ];

  /* Firestore read ceilings. The registry is a platform catalogue, not a feed;
     if it ever exceeds these, it needs pagination, not a bigger number. */
  var LIMITS = { services: 300, health: 300, deps: 500, webhooks: 300 };

  var EM = '—';   /* em dash — the neutral state, never "0" */

  /* ── State ───────────────────────────────────────────────────────────── */

  var _root     = null;
  var _mounted  = false;
  var _loading  = false;
  var _tab      = 'catalogue';
  var _selected = null;
  var _selKind  = 'catalogue';   /* 'catalogue' | 'service' */
  var _detailTab = 'overview';

  /* The declared inventory of every system SOKONI integrates with. Loaded from
     sokoni-integration-catalogue.js. If that file is absent the console still
     works — the Catalogue and Credentials tabs simply say so rather than
     rendering an empty inventory that would read as "no integrations". */
  function _cat() { return window.SokoniIntegrationCatalogue || null; }

  /* Presentation for the catalogue's six status values. The vocabulary is
     closed: a status not listed here renders neutral rather than guessing. */
  var STATUS_META = {
    live:           { cls: 'healthy',  label: 'Live' },
    'inbound-only': { cls: 'degraded', label: 'Inbound only' },
    sandbox:        { cls: 'degraded', label: 'Sandbox' },
    configured:     { cls: 'unknown',  label: 'Configured' },
    quarantined:    { cls: 'error',    label: 'Quarantined' },
    retired:        { cls: 'unknown',  label: 'Retired' },
    frozen:         { cls: 'degraded', label: 'Frozen' },
  };
  function _statusMeta(s) { return STATUS_META[s] || { cls: 'unknown', label: s || 'Unknown' }; }

  /* Each source carries its own outcome so the UI can tell "none" from
     "could not read". `ok:null` = not attempted yet. */
  var _data = {
    services:  { ok: null, rows: [], error: '' },
    health:    { ok: null, byId: {}, error: '' },
    deps:      { ok: null, rows: [], error: '' },
    webhooks:  { ok: null, rows: [], error: '' },
    /* RC-1 configuration + RC-3 probe evidence, exactly as the backend returned
       it. Nothing in this module recomputes any of it. */
    status:    { ok: null, byId: {}, counts: {}, error: '', checkedAt: '', inventoryReadable: null },
    loadedAt:  0,
  };

  var _filter = { q: '', type: '', status: '' };
  /* Optional injection point. Both consoles mount with a target only, so this
     stays empty in production and the dispatcher path above is used. */
  var _opts = {};

  /* ── Backend state vocabulary — PRESENTATION ONLY ────────────────────
     These maps turn a backend value into a label and a CSS class. They decide
     NOTHING. If a state arrives that is not listed, it is shown verbatim as
     unknown rather than guessed at — inventing a display state is how a console
     starts disagreeing with the backend that owns the truth.

     The backend owns two separate answers and this module keeps them separate:
       credentialState  RC-1 / Secret Manager — is the credential provisioned
       health           RC-3 / probe evidence  — did the provider actually answer
     A configured credential is NEVER rendered as a working provider. */
  var CRED_META = {
    'configured':     { cls: 'healthy',  label: 'Configured' },
    'partial':        { cls: 'degraded', label: 'Partially configured' },
    'missing':        { cls: 'error',    label: 'Missing' },
    'not-applicable': { cls: 'unknown',  label: 'Not applicable' },
    'disabled':       { cls: 'unknown',  label: 'Disabled' },
    'unknown':        { cls: 'unknown',  label: 'Unknown' },
  };
  /* Three of these describe an ABSENCE of observation and are deliberately all
     NEUTRAL — none carries a success colour:

       Not yet tested      measurable here, simply not established yet
       Observed elsewhere  a real signal exists, authoritatively OUTSIDE this
                           console. It says WHERE to look, not that the answer
                           was good, so it must never read as success.
       Not applicable      health is not a meaningful concept for this capability

     Collapsing them would lose the most actionable one: an operator seeing "Not
     applicable" on Cloudflare would stop investigating an edge problem that IS
     observable, just not here. */
  var HEALTH_META = {
    'connected':          { cls: 'healthy',  label: 'Connected' },
    'degraded':           { cls: 'degraded', label: 'Degraded' },
    'failed':             { cls: 'error',    label: 'Failed' },
    'missing':            { cls: 'error',    label: 'Credentials missing' },
    'disabled':           { cls: 'unknown',  label: 'Disabled' },
    'observed-elsewhere': { cls: 'unknown',  label: 'Observed elsewhere' },
    'not-applicable':     { cls: 'unknown',  label: 'Not applicable' },
    'unknown':            { cls: 'unknown',  label: 'Not yet tested' },
  };
  function _credMeta(v)   { return CRED_META[v]   || { cls: 'unknown', label: String(v || 'Unknown') }; }
  function _healthMeta(v) { return HEALTH_META[v] || { cls: 'unknown', label: String(v || 'Unknown') }; }

  /* A stage is true | false | null. null is UNKNOWN and is deliberately falsy,
     so this renders three outcomes and never treats unknown as proven. */
  function _stageWord(v, supported) {
    if (supported === 'not-supported') return 'n/a';
    if (v === true)  return 'yes';
    if (v === false) return 'no';
    return 'unknown';
  }

  function _statusFor(id) { return _data.status.byId[id] || null; }

  /* ── Helpers ─────────────────────────────────────────────────────────── */

  function _esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** A count we actually read. `n` may legitimately be 0; `unknown` is EM. */
  function _count(ok, n) { return ok ? String(n) : EM; }

  /** Firestore Timestamp | epoch ms | null → epoch ms, or 0 when absent. */
  function _ms(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (e) { return 0; } }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    return 0;
  }

  function _ago(ms) {
    if (!ms) return EM;
    var d = Date.now() - ms;
    if (d < 0) return 'just now';
    var m = Math.floor(d / 60000);
    if (m < 1)    return 'just now';
    if (m < 60)   return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24)   return h + 'h ' + (m % 60) + 'm ago';
    var dd = Math.floor(h / 24);
    return dd + 'd ago';
  }

  function _stamp(ms) {
    if (!ms) return EM;
    try { return new Date(ms).toLocaleString(); } catch (e) { return EM; }
  }

  /** Hostname of a webhook URL, for a table cell that must not wrap forever. */
  function _host(url) {
    try { return new URL(String(url)).host; } catch (e) { return String(url || '').slice(0, 60); }
  }

  function _db() {
    if (typeof firebase === 'undefined' || !firebase.firestore) return null;
    try { return firebase.firestore(); } catch (e) { return null; }
  }

  /* ── Health derivation ───────────────────────────────────────────────
     The ONLY place a service's status is decided. Four outcomes:

       healthy    a fresh heartbeat reporting healthy
       degraded   a fresh heartbeat reporting degraded
       error      a fresh heartbeat reporting unhealthy
       stale      a heartbeat older than STALE_MS
       unknown    NO heartbeat document at all

     `unknown` is never folded into healthy, and never counted as an error —
     it is reported separately so an operator can see the registry has services
     nothing is reporting on. */
  function _derive(serviceId) {
    var h = _data.health.byId[serviceId];
    if (!_data.health.ok) return { key: 'unknown', label: 'Unknown', hb: 0, h: {} };
    if (!h)               return { key: 'unknown', label: 'No heartbeat', hb: 0, h: {} };

    var hb = _ms(h.lastHeartbeat);
    if (!hb)                          return { key: 'unknown', label: 'No heartbeat', hb: 0, h: h };
    if (Date.now() - hb > STALE_MS)   return { key: 'stale', label: 'Stale', hb: hb, h: h };

    if (h.status === 'healthy')   return { key: 'healthy',  label: 'Healthy',  hb: hb, h: h };
    if (h.status === 'degraded')  return { key: 'degraded', label: 'Degraded', hb: hb, h: h };
    if (h.status === 'unhealthy') return { key: 'error',    label: 'Error',    hb: hb, h: h };
    return { key: 'unknown', label: 'Unknown', hb: hb, h: h };
  }

  /** Header tallies. Returns null when the health source could not be read —
      the caller renders EM rather than an invented zero. */
  function _tally() {
    if (!_data.services.ok || !_data.health.ok) return null;
    var t = { healthy: 0, attention: 0, errors: 0, unknown: 0 };
    _data.services.rows.forEach(function (s) {
      var k = _derive(s.serviceId || s.id).key;
      if (k === 'healthy')                       t.healthy++;
      else if (k === 'degraded' || k === 'stale') t.attention++;
      else if (k === 'error')                    t.errors++;
      else                                       t.unknown++;
    });
    return t;
  }

  /* ── Styles ──────────────────────────────────────────────────────────
     Injected once, namespaced `sic-`. Every colour resolves through a local
     token that falls back across BOTH consoles' variable sets — AdminOS uses
     --aos-*, Super Admin uses --surface/--border/--accent — so the panel adopts
     whichever console it is mounted in without either page restyling it. */
  function _styles() {
    if (document.getElementById('sicStyles')) return;
    var el = document.createElement('style');
    el.id = 'sicStyles';
    el.textContent = [
      '.sic{',
      '--sic-surface:var(--aos-surface,var(--surface,rgba(255,255,255,.03)));',
      '--sic-surface2:var(--aos-surface2,var(--card,rgba(255,255,255,.06)));',
      '--sic-border:var(--aos-border,var(--border,rgba(255,255,255,.08)));',
      '--sic-accent:var(--aos-accent,var(--accent,#71ff00));',
      '--sic-text:var(--aos-text,var(--text,rgba(255,255,255,.9)));',
      '--sic-muted:var(--aos-muted,var(--muted,rgba(255,255,255,.4)));',
      '--sic-ok:var(--aos-success,var(--green,#4caf50));',
      '--sic-warn:var(--aos-warn,var(--orange,#ff9800));',
      '--sic-bad:var(--aos-danger,var(--red,#f44336));',
      '--sic-radius:var(--aos-radius,var(--radius,10px));',
      'display:block;color:var(--sic-text);font-size:14px}',

      '.sic-head{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px;margin-bottom:20px}',
      '.sic-head h2{font-size:20px;font-weight:700;margin:0}',
      '.sic-head p{font-size:12px;color:var(--sic-muted);margin:4px 0 0;max-width:62ch}',
      '.sic-head-actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}',

      '.sic-stats{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px}',
      '.sic-stat{background:var(--sic-surface);border:1px solid var(--sic-border);',
      'border-radius:var(--sic-radius);padding:12px 16px;min-width:140px}',
      '.sic-stat .l{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--sic-muted);',
      'display:flex;align-items:center;gap:6px}',
      '.sic-stat .v{font-size:24px;font-weight:800;line-height:1.1;margin-top:4px}',
      '.sic-stat .s{font-size:11px;color:var(--sic-muted);margin-top:2px}',
      '.sic-stat.ok{border-color:rgba(76,175,80,.3)}.sic-stat.ok .v{color:var(--sic-ok)}',
      '.sic-stat.warn{border-color:rgba(255,152,0,.3)}.sic-stat.warn .v{color:var(--sic-warn)}',
      '.sic-stat.bad{border-color:rgba(244,67,54,.3)}.sic-stat.bad .v{color:var(--sic-bad)}',

      '.sic-tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--sic-border);margin-bottom:16px}',
      '.sic-tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--sic-muted);',
      'padding:9px 14px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:7px}',
      '.sic-tab:hover{color:var(--sic-text)}',
      '.sic-tab[aria-selected="true"]{color:var(--sic-accent);border-bottom-color:var(--sic-accent);font-weight:600}',
      '.sic-pill{background:var(--sic-surface2);border-radius:10px;padding:1px 7px;font-size:10px;font-weight:700}',

      '.sic-toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;align-items:center}',
      '.sic-input,.sic-select{background:var(--sic-surface);border:1px solid var(--sic-border);',
      'border-radius:8px;color:var(--sic-text);padding:8px 12px;font-size:13px;outline:none;font-family:inherit}',
      '.sic-input:focus,.sic-select:focus{border-color:var(--sic-accent)}',
      '.sic-input{min-width:200px;flex:1 1 200px;max-width:340px}',
      '.sic-btn{background:var(--sic-surface2);border:1px solid var(--sic-border);border-radius:8px;',
      'color:var(--sic-text);padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit}',
      '.sic-btn:hover{border-color:var(--sic-accent);color:var(--sic-accent)}',

      '.sic-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}',
      '.sic-layout.has-detail{grid-template-columns:minmax(0,1fr) 380px}',
      '@media(max-width:1100px){.sic-layout.has-detail{grid-template-columns:minmax(0,1fr)}}',

      '.sic-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}',
      '.sic-table{width:100%;border-collapse:collapse;font-size:13px;min-width:680px}',
      '.sic-table th{text-align:left;font-size:10px;letter-spacing:.06em;text-transform:uppercase;',
      'color:var(--sic-muted);font-weight:600;padding:10px 12px;border-bottom:1px solid var(--sic-border);white-space:nowrap}',
      '.sic-table td{padding:11px 12px;border-bottom:1px solid var(--sic-border);vertical-align:top}',
      '.sic-table tbody tr{cursor:pointer}',
      '.sic-table tbody tr:hover{background:rgba(255,255,255,.04)}',
      '.sic-table tbody tr[aria-selected="true"]{background:rgba(255,255,255,.07)}',
      '.sic-name{font-weight:600}',
      '.sic-sub{font-size:11px;color:var(--sic-muted);margin-top:2px;word-break:break-word}',
      '.sic-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',

      '.sic-badge{display:inline-flex;align-items:center;gap:6px;border-radius:99px;padding:3px 9px;',
      'font-size:11px;font-weight:600;white-space:nowrap;border:1px solid var(--sic-border);background:var(--sic-surface2)}',
      '.sic-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--sic-muted)}',
      '.sic-badge.healthy{border-color:rgba(76,175,80,.4);color:var(--sic-ok)}.sic-badge.healthy .sic-dot{background:var(--sic-ok)}',
      '.sic-badge.degraded,.sic-badge.stale{border-color:rgba(255,152,0,.4);color:var(--sic-warn)}',
      '.sic-badge.degraded .sic-dot,.sic-badge.stale .sic-dot{background:var(--sic-warn)}',
      '.sic-badge.error{border-color:rgba(244,67,54,.4);color:var(--sic-bad)}.sic-badge.error .sic-dot{background:var(--sic-bad)}',
      '.sic-badge.unknown{color:var(--sic-muted)}',

      '.sic-chip{display:inline-block;background:var(--sic-surface2);border:1px solid var(--sic-border);',
      'border-radius:6px;padding:2px 8px;font-size:11px;margin:0 4px 4px 0}',
      '.sic-chip.adhoc{border-color:rgba(255,152,0,.4);color:var(--sic-warn)}',

      '.sic-card{background:var(--sic-surface);border:1px solid var(--sic-border);',
      'border-radius:var(--sic-radius);padding:16px}',
      '.sic-detail{position:sticky;top:76px;max-height:calc(100vh - 100px);overflow-y:auto}',
      '@media(max-width:1100px){.sic-detail{position:static;max-height:none}}',
      '.sic-detail-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}',
      '.sic-detail-head h3{font-size:15px;font-weight:700;margin:0}',
      /* 32x32 minimum. This was 25x18 — below a comfortable touch target on a
         phone, and only visible once the page was rendered in a real browser. */
      '.sic-x{margin-left:auto;background:none;border:none;color:var(--sic-muted);cursor:pointer;' +
        'font-size:16px;line-height:1;min-width:32px;min-height:32px;display:inline-flex;' +
        'align-items:center;justify-content:center;border-radius:6px}',
      '.sic-x:hover{color:var(--sic-bad)}',
      '.sic-subtabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px}',
      '.sic-subtab{background:none;border:1px solid var(--sic-border);border-radius:99px;color:var(--sic-muted);',
      'padding:4px 11px;font-size:11px;cursor:pointer;font-family:inherit}',
      '.sic-subtab[aria-selected="true"]{border-color:var(--sic-accent);color:var(--sic-accent);font-weight:600}',
      '.sic-kv{display:flex;justify-content:space-between;gap:14px;padding:7px 0;',
      'border-bottom:1px solid var(--sic-border);font-size:12.5px}',
      '.sic-kv:last-child{border-bottom:none}',
      '.sic-kv>span{color:var(--sic-muted);flex-shrink:0}',
      '.sic-kv>strong{text-align:right;word-break:break-word;font-weight:600}',
      '.sic-sect-l{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--sic-muted);',
      'font-weight:700;margin:14px 0 8px}',

      /* Catalogue grid */
      '.sic-group{margin-bottom:26px}',
      '.sic-group-h{display:flex;align-items:center;gap:9px;font-size:11px;font-weight:700;',
      'letter-spacing:.07em;text-transform:uppercase;color:var(--sic-muted);margin-bottom:11px}',
      '.sic-group-i{font-size:14px}',
      '.sic-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}',
      '.sic-ic{display:flex;flex-direction:column;gap:9px;text-align:left;font-family:inherit;',
      'background:var(--sic-surface);border:1px solid var(--sic-border);border-radius:var(--sic-radius);',
      'padding:14px;cursor:pointer;color:var(--sic-text);transition:border-color .15s,background .15s}',
      '.sic-ic:hover{border-color:var(--sic-accent);background:var(--sic-surface2)}',
      '.sic-ic:focus-visible{outline:2px solid var(--sic-accent);outline-offset:2px}',
      '.sic-ic[aria-selected="true"]{border-color:var(--sic-accent);background:var(--sic-surface2)}',
      '.sic-ic-top{display:flex;align-items:flex-start;gap:10px}',
      '.sic-ic-icon{font-size:20px;line-height:1.2;flex-shrink:0}',
      '.sic-ic-id{min-width:0;flex:1}',
      '.sic-ic-id .sic-name{font-size:13.5px;line-height:1.3}',
      '.sic-ic-top .sic-badge{flex-shrink:0}',
      '.sic-ic-sum{font-size:12px;color:var(--sic-muted);line-height:1.55;margin:0}',
      '.sic-ic-foot{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;padding-top:4px}',
      '.sic-sig{font-size:10.5px;font-weight:600;border-radius:5px;padding:2px 7px;',
      'background:var(--sic-surface2);border:1px solid var(--sic-border);white-space:nowrap}',
      '.sic-sig.muted{color:var(--sic-muted);font-weight:500}',
      '.sic-sig.warn{color:var(--sic-warn);border-color:rgba(255,152,0,.35)}',
      '.sic-sig.bad{color:var(--sic-bad);border-color:rgba(244,67,54,.35)}',
      '@media(max-width:480px){.sic-grid{grid-template-columns:minmax(0,1fr)}}',

      '.sic-note{font-size:11.5px;color:var(--sic-muted);margin-top:14px;line-height:1.6}',
      '.sic-empty{padding:34px 16px;text-align:center;color:var(--sic-muted);font-size:13px}',
      '.sic-err{border:1px solid rgba(244,67,54,.35);background:rgba(244,67,54,.06);color:var(--sic-bad);',
      'border-radius:var(--sic-radius);padding:12px 14px;font-size:12.5px;margin-bottom:14px}',
      '.sic-skel{height:52px;border-radius:var(--sic-radius);margin-bottom:8px;',
      'background:linear-gradient(90deg,var(--sic-surface) 25%,rgba(255,255,255,.06) 37%,var(--sic-surface) 63%);',
      'background-size:400% 100%;animation:sicsk 1.2s ease infinite}',
      '@keyframes sicsk{0%{background-position:100% 50%}100%{background-position:0 50%}}',
      '@media(prefers-reduced-motion:reduce){.sic-skel{animation:none}}',
    ].join('');
    document.head.appendChild(el);
  }

  /* ── Loading ─────────────────────────────────────────────────────────
     Each source is read and judged INDEPENDENTLY. One denied read must not
     blank the whole console, and must not be reported as "none found". */
  function _read(coll, limit) {
    var db = _db();
    if (!db) return Promise.resolve({ ok: false, docs: [], error: 'Firestore is not initialised on this page.' });
    return db.collection(coll).limit(limit).get()
      .then(function (snap) {
        var out = [];
        snap.forEach(function (d) {
          var o = d.data() || {};
          o.id = d.id;
          out.push(o);
        });
        return { ok: true, docs: out, error: '' };
      })
      .catch(function (e) {
        return { ok: false, docs: [], error: (e && e.message) || 'Read failed.' };
      });
  }

  /* ── The authoritative status read ───────────────────────────────────
     ONE backend call, returning RC-1's configuration answer and RC-3's probe
     evidence for all 35 integrations. This module stores it and renders it; it
     does not merge, re-derive or second-guess any of it.

     `getStatus` may be injected at mount for tests and for a console that
     already owns a dispatcher. Otherwise the op goes through adminOsDispatch,
     the same hub every other admin read uses, rather than standing up a second
     path to the same handler. */
  function _readStatus() {
    var injected = _opts.getIntegrationStatus;
    var call;
    if (typeof injected === 'function') {
      call = injected();
    } else if (typeof firebase !== 'undefined' && firebase.functions) {
      try {
        call = firebase.functions()
          .httpsCallable('adminOsDispatch')({ op: 'adminGetIntegrationStatus' })
          .then(function (r) { return r.data; });
      } catch (e) {
        return Promise.resolve({ ok: false, error: (e && e.message) || 'Call failed.' });
      }
    } else {
      return Promise.resolve({ ok: false, error: 'Firebase Functions is not available on this page.' });
    }
    return call.then(function (d) { return { ok: true, data: d }; })
               .catch(function (e) { return { ok: false, error: (e && e.message) || 'Call failed.' }; });
  }

  function load() {
    if (_loading) return Promise.resolve();
    _loading = true;
    _render();

    return Promise.all([
      _read('platformServices',     LIMITS.services),
      _read('platformHealth',       LIMITS.health),
      _read('platformDependencies', LIMITS.deps),
      _read('posWebhooks',          LIMITS.webhooks),
      _readStatus(),
    ]).then(function (r) {
      _data.services = { ok: r[0].ok, rows: r[0].docs, error: r[0].error };

      var byId = {};
      r[1].docs.forEach(function (h) { byId[h.serviceId || h.id] = h; });
      _data.health = { ok: r[1].ok, byId: byId, error: r[1].error };

      _data.deps     = { ok: r[2].ok, rows: r[2].docs, error: r[2].error };
      _data.webhooks = { ok: r[3].ok, rows: r[3].docs, error: r[3].error };

      /* Stored verbatim. A failed read is recorded as a FAILED READ — it must
         never be rendered as "nothing is configured", which is the mistake this
         whole surface exists to stop making. */
      var st = r[4];
      if (st.ok && st.data && st.data.integrations) {
        var map = {};
        st.data.integrations.forEach(function (i) { map[i.id] = i; });
        _data.status = { ok: true, byId: map, counts: st.data.counts || {}, error: '',
                         checkedAt: st.data.checkedAt || '',
                         inventoryReadable: st.data.inventoryReadable };
      } else {
        _data.status = { ok: false, byId: {}, counts: {},
                         error: st.error || 'Status unavailable.',
                         checkedAt: '', inventoryReadable: null };
      }
      _data.loadedAt = Date.now();
      _loading = false;
      _render();
    });
  }

  /* ── Filtering ───────────────────────────────────────────────────────── */

  function _rows() {
    var q = _filter.q.trim().toLowerCase();
    return _data.services.rows.filter(function (s) {
      var id = s.serviceId || s.id || '';
      if (_filter.type && s.type !== _filter.type) return false;
      if (_filter.status && _derive(id).key !== _filter.status) return false;
      if (!q) return true;
      return (id + ' ' + (s.name || '') + ' ' + (s.description || '') + ' ' +
              (s.uses || []).join(' ')).toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) {
      return String(a.name || a.serviceId || '').localeCompare(String(b.name || b.serviceId || ''));
    });
  }

  /* ── Renderers ───────────────────────────────────────────────────────── */

  function _badge(d) {
    return '<span class="sic-badge ' + d.key + '"><span class="sic-dot"></span>' + _esc(d.label) + '</span>';
  }

  function _sourceError(src, label) {
    if (src.ok !== false) return '';
    return '<div class="sic-err"><strong>' + _esc(label) + ' unavailable.</strong> ' +
           _esc(src.error) + ' Figures that depend on it show ' + EM + ' rather than zero.</div>';
  }

  function _stats() {
    var t = _tally();
    var total = _data.services.ok ? _data.services.rows.length : null;

    function cell(cls, label, value, sub) {
      return '<div class="sic-stat ' + cls + '"><div class="l">' + _esc(label) + '</div>' +
             '<div class="v">' + value + '</div><div class="s">' + _esc(sub) + '</div></div>';
    }

    var c    = _cat();
    var live = c ? c.integrations.filter(function (i) { return i.status === 'live'; }).length : null;

    return '<div class="sic-stats">' +
      cell('', 'Integrations', c ? String(c.integrations.length) : EM,
           c ? 'in the declared catalogue' : 'catalogue not loaded') +
      cell('ok', 'Live rails', live === null ? EM : String(live),
           live === null ? 'catalogue not loaded' : 'serving production traffic') +
      cell('', 'Registered', total === null ? EM : String(total),
           total === null ? 'registry unreadable' : 'services in platformServices') +
      cell('ok', 'Healthy', t ? String(t.healthy) : EM,
           t ? 'fresh heartbeat' : 'heartbeat source unavailable') +
      cell('warn', 'Attention', t ? String(t.attention) : EM,
           t ? 'degraded or stale' : 'heartbeat source unavailable') +
      cell('bad', 'Errors', t ? String(t.errors) : EM,
           t ? 'reporting unhealthy' : 'heartbeat source unavailable') +
      cell('', 'No heartbeat', t ? String(t.unknown) : EM,
           t ? 'registered, never reported' : 'heartbeat source unavailable') +
      '</div>';
  }

  function _tabs() {
    var c     = _cat();
    var catN  = c ? String(c.integrations.length) : EM;
    var credN = c ? String(c.secrets().length) : EM;
    var svcN  = _count(_data.services.ok, _data.services.rows.length);
    var capN  = _count(_data.services.ok, _capabilities().length);
    var depN  = _count(_data.deps.ok, _data.deps.rows.length);
    var whN   = _count(_data.webhooks.ok, _data.webhooks.rows.length);

    var defs = [
      ['catalogue',    'Catalogue',    catN],
      ['registered',   'Self-registration log', svcN],
      ['capabilities', 'Capabilities', capN],
      ['dependencies', 'Dependencies', depN],
      ['webhooks',     'Webhooks',     whN],
      ['credentials',  'Credentials',  credN],
    ];
    return '<div class="sic-tabs" role="tablist">' + defs.map(function (d) {
      return '<button class="sic-tab" role="tab" aria-selected="' + (_tab === d[0]) + '" ' +
             'onclick="SokoniIntegrations.tab(\'' + d[0] + '\')">' + _esc(d[1]) +
             '<span class="sic-pill">' + d[2] + '</span></button>';
    }).join('') + '</div>';
  }

  function _toolbar() {
    if (_tab === 'catalogue') return _catalogueToolbar();
    if (_tab !== 'registered') return '';
    var types = ['platform', 'product', 'integration', 'infrastructure', 'ai'];
    var states = [
      ['healthy', 'Healthy'], ['degraded', 'Degraded'], ['stale', 'Stale'],
      ['error', 'Error'], ['unknown', 'No heartbeat'],
    ];
    return '<div class="sic-toolbar">' +
      '<input class="sic-input" type="search" placeholder="Search integrations…" ' +
      'aria-label="Search integrations" value="' + _esc(_filter.q) + '" ' +
      'oninput="SokoniIntegrations.filter({q:this.value})">' +
      '<select class="sic-select" aria-label="Filter by type" onchange="SokoniIntegrations.filter({type:this.value})">' +
      '<option value="">All types</option>' + types.map(function (t) {
        return '<option value="' + t + '"' + (_filter.type === t ? ' selected' : '') + '>' + t + '</option>';
      }).join('') + '</select>' +
      '<select class="sic-select" aria-label="Filter by status" onchange="SokoniIntegrations.filter({status:this.value})">' +
      '<option value="">All statuses</option>' + states.map(function (s) {
        return '<option value="' + s[0] + '"' + (_filter.status === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
      }).join('') + '</select>' +
      '</div>';
  }

  /* ── Catalogue ───────────────────────────────────────────────────────
     The declared inventory: every system SOKONI integrates with, grouped by
     category. Where an entry names a live health source, that source's real
     state is overlaid on the card; where it does not, the card says the rail
     is not instrumented rather than showing a reassuring green light. */

  function _catRows() {
    var c = _cat();
    if (!c) return [];
    var q = _filter.q.trim().toLowerCase();
    return c.integrations.filter(function (i) {
      if (_filter.type && i.category !== _filter.type) return false;
      if (_filter.status && i.status !== _filter.status) return false;
      if (!q) return true;
      var ev = i.evidence || {};
      var hay = [i.name, i.vendor, i.summary, i.notes, i.id,
                 (ev.modules || []).join(' '), (ev.secrets || []).join(' '),
                 (ev.endpoints || []).join(' '), (ev.collections || []).join(' ')].join(' ');
      return hay.toLowerCase().indexOf(q) !== -1;
    });
  }

  function _catalogueToolbar() {
    var c = _cat();
    if (!c) return '';
    var statuses = ['live', 'inbound-only', 'sandbox', 'configured', 'quarantined', 'retired', 'frozen'];
    return '<div class="sic-toolbar">' +
      '<input class="sic-input" type="search" placeholder="Search integrations, vendors, modules, secrets…" ' +
      'aria-label="Search the integration catalogue" value="' + _esc(_filter.q) + '" ' +
      'oninput="SokoniIntegrations.filter({q:this.value})">' +
      '<select class="sic-select" aria-label="Filter by category" onchange="SokoniIntegrations.filter({type:this.value})">' +
      '<option value="">All categories</option>' + c.categories.map(function (k) {
        return '<option value="' + k.id + '"' + (_filter.type === k.id ? ' selected' : '') + '>' +
               _esc(k.label) + '</option>';
      }).join('') + '</select>' +
      '<select class="sic-select" aria-label="Filter by status" onchange="SokoniIntegrations.filter({status:this.value})">' +
      '<option value="">All statuses</option>' + statuses.map(function (s) {
        return '<option value="' + s + '"' + (_filter.status === s ? ' selected' : '') + '>' +
               _esc(_statusMeta(s).label) + '</option>';
      }).join('') + '</select>' +
      '</div>';
  }

  /** The live overlay for a catalogue card, or an honest statement of silence. */
  function _liveSignal(entry) {
    var src = (entry.health || {}).source;
    if (!src) return '<span class="sic-sig muted">Not instrumented</span>';

    if (src === 'posWebhooks') {
      if (!_data.webhooks.ok) return '<span class="sic-sig muted">Endpoint state unreadable</span>';
      var active = 0, failing = 0;
      _data.webhooks.rows.forEach(function (w) {
        if (w.active) active++;
        if ((w.failureCount || 0) > 0) failing++;
      });
      return '<span class="sic-sig">' + active + ' active endpoint' + (active === 1 ? '' : 's') + '</span>' +
             (failing ? '<span class="sic-sig bad">' + failing + ' with failures</span>' : '');
    }
    if (src === 'posAPIKeys') {
      /* posAPIKeys is not read by this console — say so rather than imply zero. */
      return '<span class="sic-sig muted">Key inventory not read here</span>';
    }
    if (src === 'platformServices') {
      if (!_data.services.ok) return '<span class="sic-sig muted">Registry unreadable</span>';
      var t = _tally();
      return '<span class="sic-sig">' + _data.services.rows.length + ' service' +
             (_data.services.rows.length === 1 ? '' : 's') + ' registered</span>' +
             (t && t.errors ? '<span class="sic-sig bad">' + t.errors + ' unhealthy</span>' : '') +
             (t && t.attention ? '<span class="sic-sig warn">' + t.attention + ' need attention</span>' : '');
    }
    return '<span class="sic-sig muted">Not instrumented</span>';
  }

  function _catalogueGrid() {
    var c = _cat();
    if (!c) {
      return '<div class="sic-card"><div class="sic-empty">The integration catalogue did not load. ' +
             'Add <span class="sic-mono">sokoni-integration-catalogue.js</span> to this page — ' +
             'this is a missing script, not an empty platform.</div></div>';
    }
    var rows = _catRows();
    if (!rows.length) {
      return '<div class="sic-card"><div class="sic-empty">No integration matches these filters.</div></div>';
    }

    /* Group into the catalogue's own category order, skipping empty groups. */
    return c.categories.map(function (k) {
      var group = rows.filter(function (i) { return i.category === k.id; });
      if (!group.length) return '';
      return '<div class="sic-group"><div class="sic-group-h">' +
        '<span class="sic-group-i" aria-hidden="true">' + k.icon + '</span>' + _esc(k.label) +
        '<span class="sic-pill">' + group.length + '</span></div>' +
        '<div class="sic-grid">' + group.map(function (i) {
          var m = _statusMeta(i.status);
          var ev = i.evidence || {};
          return '<button class="sic-ic" aria-selected="' + (_selKind === 'catalogue' && _selected === i.id) + '" ' +
            'onclick="SokoniIntegrations.selectCatalogue(\'' + _esc(i.id) + '\')">' +
            '<div class="sic-ic-top">' +
            '<span class="sic-ic-icon" aria-hidden="true">' + i.icon + '</span>' +
            '<div class="sic-ic-id"><div class="sic-name">' + _esc(i.name) + '</div>' +
            '<div class="sic-sub">' + _esc(i.vendor) + '</div></div>' +
            '<span class="sic-badge ' + m.cls + '"><span class="sic-dot"></span>' + _esc(m.label) + '</span>' +
            '</div>' +
            '<p class="sic-ic-sum">' + _esc(i.summary) + '</p>' +
            '<div class="sic-ic-foot">' +
            '<span class="sic-sig muted">' + _esc(i.direction) + '</span>' +
            _liveSignal(i) +
            ((ev.secrets || []).length ? '<span class="sic-sig muted">' + ev.secrets.length + ' secret' +
              (ev.secrets.length === 1 ? '' : 's') + '</span>' : '') +
            '</div></button>';
        }).join('') + '</div></div>';
    }).join('');
  }

  /* ── The measured state of one integration ───────────────────────────
     Everything here comes from the backend record. The console decides nothing:
     it does not infer health from a configured credential, it does not promote
     an accepted request to a delivery, and it shows a stage the rail cannot
     evidence as "n/a" rather than as a failure.

     The five stages are shown individually on purpose. "Accepted" and
     "Delivered" are different claims, and a surface that collapsed them would
     show a green tick for a channel nobody is receiving on. */
  /* The operator-facing pointer for a health kind. Rendered as a plain note,
     never as a status badge: a signal existing somewhere else is not evidence
     that the answer is good. */
  function _kindPointer(id) {
    var c = _cat();
    var e = c && c.lookup ? c.lookup(id) : null;
    var h = e && e.health;
    if (!h || !h.kindNote) return '';
    if (h.kind === 'elsewhere') {
      return '<p class="sic-note"><strong>Observed elsewhere:</strong> ' + _esc(h.kindNote) + '</p>';
    }
    if (h.kind === 'not-applicable') {
      return '<p class="sic-note"><strong>Not applicable:</strong> ' + _esc(h.kindNote) + '</p>';
    }
    return '';
  }

  function _liveState(id) {
    if (_data.status.ok === false) {
      return '<div class="sic-kv"><span>Configuration</span><strong>' +
        '<span class="sic-badge unknown"><span class="sic-dot"></span>Unreadable</span></strong></div>' +
        '<p class="sic-note">Status could not be read: ' + _esc(_data.status.error) +
        '. This is a failed read, not an unconfigured integration.</p>';
    }
    var r = _statusFor(id);
    if (!r) return '';

    var cm = _credMeta(r.credentialState);
    var hm = _healthMeta(r.health);
    var st = r.stages || {};
    var sup = r.stageSupport || {};

    var stageRow = ['connected', 'accepted', 'delivered', 'received'].map(function (k) {
      var w = _stageWord(st[k], sup[k]);
      var cls = w === 'yes' ? 'healthy' : w === 'no' ? 'error' : 'unknown';
      var label = k.charAt(0).toUpperCase() + k.slice(1);
      var shown = w === 'yes' ? 'proven' : w === 'no' ? 'failed' : w === 'n/a' ? 'n/a' : 'unknown';
      return '<span class="sic-chip"><span class="sic-badge ' + cls + '">' +
             '<span class="sic-dot"></span>' + _esc(label) + ': ' + shown + '</span></span>';
    }).join('');

    var canProbe = (r.capabilities || []).indexOf('test') > -1;

    return '<div class="sic-kv"><span>Configuration</span><strong><span class="sic-badge ' + cm.cls +
      '"><span class="sic-dot"></span>' + _esc(cm.label) + '</span></strong></div>' +
      '<div class="sic-kv"><span>Provider health</span><strong><span class="sic-badge ' + hm.cls +
      '"><span class="sic-dot"></span>' + _esc(hm.label) + '</span></strong></div>' +
      '<div class="sic-sect-l">What was actually proven</div>' +
      '<div>' + stageRow + '</div>' +
      (r.healthNote ? '<p class="sic-note">' + _esc(r.healthNote) + '</p>' : '') +
      /* For a rail classified 'elsewhere' the useful thing is WHERE the
         authoritative signal is read. The catalogue already carries that and is
         loaded on this page, so the pointer is taken from there rather than
         pushed through the backend — it is documentation, not runtime state. */
      _kindPointer(id) +
      '<div class="sic-kv"><span>Evidence</span><strong>' + _esc(r.evidence || 'none') + '</strong></div>' +
      '<div class="sic-kv"><span>Last probed</span><strong>' +
        (r.probedAt ? _esc(r.probedAt) : EM) + '</strong></div>' +
      '<div class="sic-kv"><span>Checked</span><strong>' +
        (r.checkedAt ? _esc(r.checkedAt) : EM) + '</strong></div>' +
      '<div class="sic-sect-l">Management</div>' +
      '<div>' + (r.capabilities || []).map(function (c2) {
        return '<span class="sic-chip sic-mono">' + _esc(c2) + '</span>';
      }).join('') + '</div>' +
      (canProbe
        ? '<p class="sic-note">A provider test is available for this integration. It never ' +
          'initiates a payment, a payout or any other movement of money, and it never sends to ' +
          'a real customer.</p>'
        : '<p class="sic-note">No provider test is offered for this integration — either its ' +
          'lifecycle is disabled, its credentials are not provisioned, or no probe exists that ' +
          'could run safely.</p>');
  }

  function _catalogueDetail() {
    var c = _cat();
    if (!c) return '';
    var i = c.lookup(_selected);
    if (!i) return '';
    var m  = _statusMeta(i.status);
    var ev = i.evidence || {};

    function list(label, arr, mono) {
      if (!arr || !arr.length) return '';
      return '<div class="sic-sect-l">' + _esc(label) + '</div>' + arr.map(function (x) {
        return '<span class="sic-chip' + (mono ? ' sic-mono' : '') + '">' + _esc(x) + '</span>';
      }).join('');
    }

    return '<aside class="sic-card sic-detail" aria-label="Integration detail">' +
      '<div class="sic-detail-head">' +
      '<span class="sic-ic-icon" aria-hidden="true">' + i.icon + '</span>' +
      '<div><h3>' + _esc(i.name) + '</h3><div class="sic-sub">' + _esc(i.vendor) + '</div></div>' +
      '<button class="sic-x" aria-label="Close detail" onclick="SokoniIntegrations.select(null)">✕</button></div>' +

      '<div class="sic-kv"><span>Status</span><strong><span class="sic-badge ' + m.cls +
      '"><span class="sic-dot"></span>' + _esc(m.label) + '</span></strong></div>' +
      '<div class="sic-kv"><span>Direction</span><strong>' + _esc(i.direction) + '</strong></div>' +
      '<div class="sic-kv"><span>Category</span><strong>' + _esc(i.category) + '</strong></div>' +
      '<div class="sic-kv"><span>Live signal</span><strong>' + _liveSignal(i) + '</strong></div>' +
      _liveState(i.id) +

      '<div class="sic-sect-l">What it does</div>' +
      '<p style="font-size:12.5px;color:var(--sic-muted);line-height:1.6">' + _esc(i.summary) + '</p>' +

      '<div class="sic-sect-l">Health</div>' +
      '<p style="font-size:12.5px;color:var(--sic-muted);line-height:1.6">' +
      _esc((i.health || {}).note || 'No health signal.') + '</p>' +

      (i.notes ? '<div class="sic-sect-l">Operating note</div>' +
        '<p style="font-size:12.5px;color:var(--sic-warn);line-height:1.6">' + _esc(i.notes) + '</p>' : '') +

      list('Implemented by', ev.modules, true) +
      list('HTTP endpoints', ev.endpoints, true) +
      list('Collections written', ev.collections, true) +
      list('Configuration', ev.env, true) +
      (ev.secrets && ev.secrets.length
        ? '<div class="sic-sect-l">Secrets required</div>' +
          ev.secrets.map(function (s) { return '<span class="sic-chip sic-mono">' + _esc(s) + '</span>'; }).join('') +
          '<p class="sic-note">Names only. No console on this platform reads or displays a secret’s value.</p>'
        : '') +
      '</aside>';
  }

  /* ── Credentials ─────────────────────────────────────────────────────
     Every secret the catalogue declares, and which rails break without it.
     This is a dependency map, not a vault: no value is read, fetched or
     rendered, and nothing here can be used to authenticate to anything. */
  function _credentialsTable() {
    var c = _cat();
    if (!c) {
      return '<div class="sic-card"><div class="sic-empty">The integration catalogue did not load, ' +
             'so credential dependencies cannot be listed.</div></div>';
    }
    var rows = c.secrets();

    /* Per-secret provisioning, taken from the backend's per-credential booleans.
       The console never asks Secret Manager anything — it cannot, and should
       not be able to. A secret whose state the backend did not report shows as
       unknown rather than as missing. */
    var provisioned = {};
    Object.keys(_data.status.byId).forEach(function (id) {
      (_data.status.byId[id].credentials || []).forEach(function (cr) {
        if (cr.present === true)  provisioned[cr.name] = true;
        else if (cr.present === false && provisioned[cr.name] !== true) provisioned[cr.name] = false;
      });
    });
    function provCell(name) {
      if (_data.status.ok !== true) {
        return '<span class="sic-badge unknown"><span class="sic-dot"></span>Unknown</span>';
      }
      var v = provisioned[name];
      if (v === true)  return '<span class="sic-badge healthy"><span class="sic-dot"></span>Provisioned</span>';
      if (v === false) return '<span class="sic-badge error"><span class="sic-dot"></span>Not provisioned</span>';
      return '<span class="sic-badge unknown"><span class="sic-dot"></span>Unknown</span>';
    }

    var banner = _data.status.ok === false
      ? '<div class="sic-empty">Credential status could not be read (' + _esc(_data.status.error) +
        '). The names below are the declared dependencies; their provisioning state is NOT known ' +
        'and must not be read as missing.</div>'
      : '';

    return '<div class="sic-card">' + banner + '<div class="sic-scroll"><table class="sic-table">' +
      '<thead><tr><th>Secret name</th><th>Provisioned</th><th>Rails that depend on it</th>' +
      '<th>Category</th></tr></thead><tbody>' +
      rows.map(function (s) {
        return '<tr style="cursor:default">' +
          '<td class="sic-mono sic-name">' + _esc(s.name) + '</td>' +
          '<td>' + provCell(s.name) + '</td>' +
          '<td>' + s.usedBy.map(function (i) {
            return '<span class="sic-chip">' + _esc(i.name) + '</span>';
          }).join('') + '</td>' +
          '<td>' + _esc(s.usedBy[0].category) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="sic-note">Secret <em>names</em> only — the identifiers passed to ' +
      '<span class="sic-mono">defineSecret()</span>. Values live in Firebase Secret Manager and are ' +
      'never read by a browser. Use this to confirm a rail’s dependencies are provisioned before ' +
      'enabling it, not to audit the values themselves.</p>' +
      '</div>';
  }

  /* ── What this tab is, and is NOT (RC-2 decision, 2026-09-20) ────────
     The registry was designed as "the authoritative source of truth that spans
     all runtimes". It cannot be, and the reason is structural rather than a
     missing producer: platformRegisterService requires an authenticated browser
     session, so no Cloud Function, trigger, scheduled job or deploy step can
     register itself. In practice ONE page calls init() — platform.html, as
     platform-ops-center — and everything else would have to be typed into its
     form by hand. platformHealthSweep then marks any heartbeat older than five
     minutes stale, and heartbeats only come from an open tab, so an entry goes
     stale within minutes of the tab closing and stays that way.

     So this tab is a LOG OF SELF-REGISTRATIONS, not an inventory. The
     authoritative model is the catalogue plus the backend's configuration and
     probe status. The registry is deliberately NOT populated from the
     catalogue: a mirrored copy that nothing maintains is exactly the staleable
     second source this console exists to stop relying on. */
  function _regNote() {
    return 'This lists services that explicitly registered themselves through the ' +
           'Platform Operations Center. An empty or stale entry does <strong>not</strong> mean ' +
           'an integration or service is unavailable — the Catalogue, Credentials and probe ' +
           'status are the authoritative model.';
  }

  function _registeredTable() {
    if (_data.services.ok === false) {
      return '<div class="sic-card"><div class="sic-empty">The service registry could not be read, ' +
             'so nothing can be listed. This is not an empty registry.</div></div>';
    }
    if (!_data.services.rows.length) {
      return '<div class="sic-card"><div class="sic-empty">' + _regNote() +
             '<br><br>Nothing has registered. platformServices is empty — a real, canonical zero, ' +
             'not a failed read, and <strong>not</strong> an indication that any integration or ' +
             'service is unavailable.</div></div>';
    }
    var rows = _rows();
    if (!rows.length) {
      return '<div class="sic-card"><div class="sic-empty">No integration matches these filters.</div></div>';
    }

    return '<div class="sic-card">' +
      '<p class="sic-note">' + _regNote() + '</p>' +
      '<div class="sic-scroll"><table class="sic-table">' +
      '<thead><tr><th>Service</th><th>Type</th><th>Version</th><th>Status</th>' +
      '<th>Last heartbeat</th><th>Latency</th><th>Error rate</th><th>Capabilities</th></tr></thead><tbody>' +
      rows.map(function (s) {
        var id = s.serviceId || s.id;
        var d  = _derive(id);
        var lat = (d.h && typeof d.h.latencyMs === 'number') ? d.h.latencyMs + ' ms' : EM;
        var err = (d.h && typeof d.h.errorRate === 'number')
          ? (Math.round(d.h.errorRate * 1000) / 10) + '%' : EM;
        return '<tr tabindex="0" role="button" aria-selected="' + (_selected === id) + '" ' +
          'onclick="SokoniIntegrations.select(\'' + _esc(id) + '\')" ' +
          'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();SokoniIntegrations.select(\'' + _esc(id) + '\')}">' +
          '<td><div class="sic-name">' + _esc(s.name || id) + '</div>' +
          '<div class="sic-sub sic-mono">' + _esc(id) + '</div></td>' +
          '<td>' + _esc(s.type || EM) + '</td>' +
          '<td class="sic-mono">' + _esc(s.version || EM) + '</td>' +
          '<td>' + _badge(d) + '</td>' +
          '<td>' + _esc(_ago(d.hb)) + '</td>' +
          '<td>' + lat + '</td>' +
          '<td>' + err + '</td>' +
          '<td>' + ((s.uses || []).length || EM) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  /** Capability → the services that DECLARE they use it. Derived purely from
      each registry document's `uses` array; nothing is assumed. */
  function _capabilities() {
    var map = {};
    _data.services.rows.forEach(function (s) {
      (s.uses || []).forEach(function (c) {
        (map[c] = map[c] || []).push(s.name || s.serviceId || s.id);
      });
    });
    /* Well-known capabilities with no declared consumer are listed too, as a
       real zero — the registry does know they exist. */
    WELL_KNOWN_CAPABILITIES.forEach(function (c) { if (!map[c]) map[c] = []; });

    return Object.keys(map).sort(function (a, b) {
      return (map[b].length - map[a].length) || a.localeCompare(b);
    }).map(function (c) {
      return { key: c, consumers: map[c], wellKnown: WELL_KNOWN_CAPABILITIES.indexOf(c) !== -1 };
    });
  }

  function _capabilitiesTable() {
    if (_data.services.ok === false) {
      return '<div class="sic-card"><div class="sic-empty">The service registry could not be read, ' +
             'so capability consumption is unknown.</div></div>';
    }
    var caps = _capabilities();
    return '<div class="sic-card">' +
      '<div class="sic-scroll"><table class="sic-table">' +
      '<thead><tr><th>Capability</th><th>Registered</th><th>Consumers</th><th>Declared by</th></tr></thead><tbody>' +
      caps.map(function (c) {
        return '<tr style="cursor:default">' +
          '<td class="sic-mono">' + _esc(c.key) + '</td>' +
          '<td>' + (c.wellKnown
            ? '<span class="sic-badge">well-known</span>'
            : '<span class="sic-badge stale"><span class="sic-dot"></span>ad hoc</span>') + '</td>' +
          '<td>' + c.consumers.length + '</td>' +
          '<td>' + (c.consumers.length
            ? c.consumers.slice(0, 6).map(function (n) { return '<span class="sic-chip">' + _esc(n) + '</span>'; }).join('') +
              (c.consumers.length > 6 ? '<span class="sic-chip">+' + (c.consumers.length - 6) + '</span>' : '')
            : '<span style="color:var(--sic-muted)">no service declares it</span>') + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="sic-note">"Ad hoc" means a service declares a capability that is not in the ' +
      'platform capability list in <span class="sic-mono">functions/platform-registry.js</span>. ' +
      'That is a registration to review, not necessarily a fault.</p>' +
      '</div>';
  }

  function _dependenciesTable() {
    if (_data.deps.ok === false) {
      return '<div class="sic-card"><div class="sic-empty">The dependency graph could not be read.</div></div>';
    }
    if (!_data.deps.rows.length) {
      return '<div class="sic-card"><div class="sic-empty">No dependency edges are declared. ' +
             'platformDependencies is empty.</div></div>';
    }
    var known = {};
    _data.services.rows.forEach(function (s) { known[s.serviceId || s.id] = true; });

    var rows = _data.deps.rows.slice().sort(function (a, b) {
      return String(a.from || '').localeCompare(String(b.from || '')) ||
             String(a.to || '').localeCompare(String(b.to || ''));
    });

    return '<div class="sic-card"><div class="sic-scroll"><table class="sic-table">' +
      '<thead><tr><th>Service</th><th>Depends on</th><th>Target registered</th><th>Declared</th></tr></thead><tbody>' +
      rows.map(function (d) {
        /* Resolvability is only knowable when the registry itself was read. */
        var resolved = _data.services.ok ? !!known[d.to] : null;
        return '<tr style="cursor:default">' +
          '<td class="sic-mono">' + _esc(d.from || EM) + '</td>' +
          '<td class="sic-mono">' + _esc(d.to || EM) + '</td>' +
          '<td>' + (resolved === null
            ? EM
            : resolved
              ? '<span class="sic-badge healthy"><span class="sic-dot"></span>yes</span>'
              : '<span class="sic-badge error"><span class="sic-dot"></span>unresolved</span>') + '</td>' +
          '<td>' + _esc(_ago(_ms(d.registeredAt))) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="sic-note">"Unresolved" means a service declared a dependency on an id that is not ' +
      'in the registry — a typo, a service that never registered, or one that was removed.</p>' +
      '</div>';
  }

  function _webhooksTable() {
    if (_data.webhooks.ok === false) {
      return '<div class="sic-card"><div class="sic-empty">Webhook endpoints could not be read.</div></div>';
    }
    if (!_data.webhooks.rows.length) {
      return '<div class="sic-card"><div class="sic-empty">No webhook endpoints are registered. ' +
             'posWebhooks is empty.</div></div>';
    }
    var rows = _data.webhooks.rows.slice().sort(function (a, b) {
      return (b.failureCount || 0) - (a.failureCount || 0) || _ms(b.createdAt) - _ms(a.createdAt);
    });

    return '<div class="sic-card"><div class="sic-scroll"><table class="sic-table">' +
      '<thead><tr><th>Endpoint</th><th>Merchant</th><th>Events</th><th>State</th>' +
      '<th>Failures</th><th>Last fired</th><th>Last status</th></tr></thead><tbody>' +
      rows.map(function (w) {
        var fails = typeof w.failureCount === 'number' ? w.failureCount : null;
        return '<tr style="cursor:default">' +
          '<td><div class="sic-name sic-mono">' + _esc(_host(w.url)) + '</div>' +
          '<div class="sic-sub">' + _esc(w.description || '') + '</div></td>' +
          '<td class="sic-mono">' + _esc(w.sellerId || EM) + '</td>' +
          '<td>' + ((w.events || []).length
            ? (w.events || []).slice(0, 3).map(function (e) { return '<span class="sic-chip">' + _esc(e) + '</span>'; }).join('') +
              ((w.events || []).length > 3 ? '<span class="sic-chip">+' + ((w.events || []).length - 3) + '</span>' : '')
            : EM) + '</td>' +
          '<td>' + (w.active
            ? '<span class="sic-badge healthy"><span class="sic-dot"></span>active</span>'
            : '<span class="sic-badge unknown"><span class="sic-dot"></span>revoked</span>') + '</td>' +
          '<td>' + (fails === null ? EM : (fails > 0
            ? '<span style="color:var(--sic-bad);font-weight:700">' + fails + '</span>' : '0')) + '</td>' +
          '<td>' + _esc(_ago(_ms(w.lastFiredAt))) + '</td>' +
          '<td>' + _esc(w.lastStatus == null ? EM : w.lastStatus) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="sic-note">Signing secrets are stored on these documents and are deliberately never ' +
      'rendered here. Rotating one is a privileged, audited operation and is not available on this screen.</p>' +
      '</div>';
  }

  /* ── Detail drawer ───────────────────────────────────────────────────── */

  function _detail() {
    if (!_selected) return '';
    var svc = null;
    _data.services.rows.forEach(function (s) { if ((s.serviceId || s.id) === _selected) svc = s; });
    if (!svc) return '';

    var id = svc.serviceId || svc.id;
    var d  = _derive(id);

    var subtabs = [['overview', 'Overview'], ['capabilities', 'Capabilities'],
                   ['events', 'Events'], ['dependencies', 'Dependencies']];

    var body;
    if (_detailTab === 'overview') {
      var lat = (d.h && typeof d.h.latencyMs === 'number') ? d.h.latencyMs + ' ms' : EM;
      var err = (d.h && typeof d.h.errorRate === 'number')
        ? (Math.round(d.h.errorRate * 1000) / 10) + '%' : EM;
      body =
        '<div class="sic-kv"><span>Status</span><strong>' + _badge(d) + '</strong></div>' +
        '<div class="sic-kv"><span>Registry status</span><strong>' + _esc(svc.status || EM) + '</strong></div>' +
        '<div class="sic-kv"><span>Type</span><strong>' + _esc(svc.type || EM) + '</strong></div>' +
        '<div class="sic-kv"><span>Version</span><strong class="sic-mono">' + _esc(svc.version || EM) + '</strong></div>' +
        '<div class="sic-kv"><span>Last heartbeat</span><strong>' + _esc(_stamp(d.hb)) + '</strong></div>' +
        '<div class="sic-kv"><span>Latency</span><strong>' + lat + '</strong></div>' +
        '<div class="sic-kv"><span>Error rate</span><strong>' + err + '</strong></div>' +
        '<div class="sic-kv"><span>Health message</span><strong>' + _esc((d.h && d.h.message) || EM) + '</strong></div>' +
        '<div class="sic-kv"><span>Registered</span><strong>' + _esc(_stamp(_ms(svc.registeredAt))) + '</strong></div>' +
        '<div class="sic-kv"><span>Registry updated</span><strong>' + _esc(_stamp(_ms(svc.updatedAt))) + '</strong></div>' +
        '<div class="sic-kv"><span>Owner uid</span><strong class="sic-mono">' + _esc(svc.ownerId || EM) + '</strong></div>' +
        (svc.url ? '<div class="sic-sect-l">Surface</div><a class="sic-mono" style="font-size:12px;color:var(--sic-accent)" href="' +
          _esc(svc.url) + '">' + _esc(svc.url) + '</a>' : '') +
        (svc.description ? '<div class="sic-sect-l">Description</div><p style="font-size:12.5px;color:var(--sic-muted)">' +
          _esc(svc.description) + '</p>' : '');
    } else if (_detailTab === 'capabilities') {
      var uses = svc.uses || [];
      body = uses.length
        ? uses.map(function (c) {
            var adhoc = WELL_KNOWN_CAPABILITIES.indexOf(c) === -1;
            return '<span class="sic-chip' + (adhoc ? ' adhoc' : '') + '">' + _esc(c) + '</span>';
          }).join('')
        : '<div class="sic-empty">This service declares no platform capabilities.</div>';
    } else if (_detailTab === 'events') {
      var pub = svc.publishesEvents || [], sub = svc.subscribesEvents || [];
      body =
        '<div class="sic-sect-l">Publishes</div>' +
        (pub.length ? pub.map(function (e) { return '<span class="sic-chip">' + _esc(e) + '</span>'; }).join('')
                    : '<div style="font-size:12.5px;color:var(--sic-muted)">None declared.</div>') +
        '<div class="sic-sect-l">Subscribes</div>' +
        (sub.length ? sub.map(function (e) { return '<span class="sic-chip">' + _esc(e) + '</span>'; }).join('')
                    : '<div style="font-size:12.5px;color:var(--sic-muted)">None declared.</div>');
    } else {
      var out = [], inn = [];
      if (_data.deps.ok) {
        _data.deps.rows.forEach(function (e) {
          if (e.from === id) out.push(e.to);
          if (e.to === id)   inn.push(e.from);
        });
      }
      body = !_data.deps.ok
        ? '<div class="sic-empty">The dependency graph could not be read.</div>'
        : '<div class="sic-sect-l">Depends on</div>' +
          (out.length ? out.map(function (x) { return '<span class="sic-chip sic-mono">' + _esc(x) + '</span>'; }).join('')
                      : '<div style="font-size:12.5px;color:var(--sic-muted)">None declared.</div>') +
          '<div class="sic-sect-l">Depended on by</div>' +
          (inn.length ? inn.map(function (x) { return '<span class="sic-chip sic-mono">' + _esc(x) + '</span>'; }).join('')
                      : '<div style="font-size:12.5px;color:var(--sic-muted)">No service declares a dependency on this one.</div>');
    }

    return '<aside class="sic-card sic-detail" aria-label="Integration detail">' +
      '<div class="sic-detail-head"><div><h3>' + _esc(svc.name || id) + '</h3>' +
      '<div class="sic-sub sic-mono">' + _esc(id) + '</div></div>' +
      '<button class="sic-x" aria-label="Close detail" onclick="SokoniIntegrations.select(null)">✕</button></div>' +
      '<div class="sic-subtabs">' + subtabs.map(function (t) {
        return '<button class="sic-subtab" aria-selected="' + (_detailTab === t[0]) + '" ' +
               'onclick="SokoniIntegrations.detailTab(\'' + t[0] + '\')">' + _esc(t[1]) + '</button>';
      }).join('') + '</div>' + body + '</aside>';
  }

  /* ── Shell ───────────────────────────────────────────────────────────── */

  function _render() {
    if (!_root) return;

    if (_loading && !_data.loadedAt) {
      _root.innerHTML = '<div class="sic"><div class="sic-head"><div><h2>Integrations</h2>' +
        '<p>Reading the platform service registry…</p></div></div>' +
        '<div class="sic-skel"></div><div class="sic-skel"></div><div class="sic-skel"></div></div>';
      return;
    }

    var panel =
      _tab === 'catalogue'    ? _catalogueGrid()     :
      _tab === 'registered'   ? _registeredTable()   :
      _tab === 'capabilities' ? _capabilitiesTable() :
      _tab === 'dependencies' ? _dependenciesTable() :
      _tab === 'credentials'  ? _credentialsTable()  :
                                _webhooksTable();

    var showDetail = _selected &&
      ((_tab === 'catalogue'  && _selKind === 'catalogue') ||
       (_tab === 'registered' && _selKind === 'service'));

    _root.innerHTML = '<div class="sic">' +
      '<div class="sic-head"><div><h2>Integrations</h2>' +
      /* Led with "Every registered platform service" until RC-2, which is the
         framing that was demoted: the registry is a self-registration log, not
         an inventory. The catalogue and the backend's configuration and probe
         status are what this page is actually about. Spotted by reading the
         rendered page rather than the markup. */
      '<p>The declared integration catalogue, each rail’s credential configuration and measured ' +
      'provider health, plus the self-registration log, capability matrix, dependency graph and ' +
      'the merchant webhook endpoints SmartPOS delivers to. Read-only.</p></div>' +
      '<div class="sic-head-actions">' +
      '<span style="font-size:11px;color:var(--sic-muted);align-self:center">' +
      (_data.loadedAt ? 'Loaded ' + _esc(_ago(_data.loadedAt)) : '') + '</span>' +
      '<button class="sic-btn" onclick="SokoniIntegrations.refresh()"' + (_loading ? ' disabled' : '') + '>' +
      (_loading ? 'Refreshing…' : '↻ Refresh') + '</button></div></div>' +

      _sourceError(_data.services, 'Service registry') +
      _sourceError(_data.health,   'Health heartbeats') +
      _sourceError(_data.deps,     'Dependency graph') +
      _sourceError(_data.webhooks, 'Webhook endpoints') +

      _stats() + _tabs() + _toolbar() +
      '<div class="sic-layout' + (showDetail ? ' has-detail' : '') + '">' +
      '<div>' + panel + '</div>' +
      (showDetail ? (_selKind === 'catalogue' ? _catalogueDetail() : _detail()) : '') + '</div>' +

      '<p class="sic-note">Sources: <span class="sic-mono">platformServices</span>, ' +
      '<span class="sic-mono">platformHealth</span>, <span class="sic-mono">platformDependencies</span>, ' +
      '<span class="sic-mono">posWebhooks</span>. A heartbeat older than ' + (STALE_MS / 60000) +
      ' minutes is stale, matching the threshold in <span class="sic-mono">platformGetHealth</span>. ' +
      'Where a source cannot be read this console shows ' + EM + ' — never 0.</p>' +
      '</div>';
  }

  /* ── Public API ──────────────────────────────────────────────────────── */

  function mount(target, opts) {
    var el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    _opts = opts || _opts || {};
    _styles();
    _root = el;
    if (_mounted) { _render(); return; }
    _mounted = true;
    load();
  }

  window.SokoniIntegrations = {
    version: '1.0.0',
    mount:   mount,
    refresh: function () { _selected = null; return load(); },
    tab: function (t) {
      _tab = t;
      /* Filters mean different things per tab (category vs service type), so a
         tab change clears them rather than silently applying a stale one. */
      _filter = { q: '', type: '', status: '' };
      _selected = null;
      _render();
    },
    detailTab: function (t) { _detailTab = t; _render(); },
    select: function (id) {
      _selKind  = 'service';
      _selected = (id && _selected !== id) ? id : null;
      if (_selected) _detailTab = 'overview';
      _render();
    },
    selectCatalogue: function (id) {
      var same = _selKind === 'catalogue' && _selected === id;
      _selKind  = 'catalogue';
      _selected = same ? null : id;
      _render();
    },
    filter: function (patch) {
      Object.keys(patch || {}).forEach(function (k) { _filter[k] = patch[k]; });
      _selected = null;
      _render();
    },
    /* Exposed for tests and for the consoles' own diagnostics. */
    _state: function () { return _data; },
  };
})();
