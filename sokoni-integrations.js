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

  var _filter = { q: '', type: '', status: '', ops: '' };
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

  /* ══ THE OPERATOR CHIP ════════════════════════════════════════════════
     One word an operator can scan, DERIVED at render time from evidence that
     already exists. It introduces no persisted field and no second
     evidence-state system: `ok: null | true | false`, the credential
     vocabulary, the probe stages and the freshness window remain the only
     authorities. This is a projection of them, nothing more.

     WHY IT EXISTS
     Until now a rail that was merely catalogued looked the same as one a probe
     had actually reached. The catalogue's lifecycle word says what we BELIEVE;
     it does not say what was OBSERVED. An operator scanning the grid could not
     tell those apart, which is the whole reason for adding this.

     PRECEDENCE IS EXPLICIT AND FIRST-MATCH.
     Ordering is the control. Measured outcomes win over explanations for the
     absence of one, so a stale or refused rail can never fall through into
     LIVE. Read this list top-down; the first that matches is the answer.

       1  EVIDENCE UNREADABLE  the status read FAILED. We know nothing, and
                               that is different from knowing there is nothing
       2  FAILED               a probe ran and the rail refused or broke
       3  DEGRADED             reachable, but a supported stage came back false
       4  STALE                it WAS connected, and the observation has aged
                               past the freshness window
       5  LIVE                 connected, and the observation is fresh
       6  GATED                deliberately closed: quarantined, frozen, retired
       7  NOT CONFIGURED       a required credential is demonstrably absent
       8  REFUSED BY DESIGN    a probe exists and deliberately will not run
       9  ACTIVE               operational evidence exists, but no live probe
      10  NOT PROBED           no live evidence path at all

     STALE BEFORE LIVE (4 before 5) is deliberate: a connected reading that has
     aged out is not a current success, and ordering it after LIVE would let an
     old observation keep a green chip indefinitely.

     GATED AFTER the measured states (6 after 2-5) is also deliberate: if a
     frozen rail somehow produced a failed probe, the FAILURE is the more urgent
     fact. Freezing describes our intent, not the rail's condition.

     REFUSED BY DESIGN NEEDS A FIELD THE BACKEND DOES NOT YET SEND.
     `notRunReason` (`no_safe_probe`, `requires_secret_binding`) is set on a
     PROBE result but is not carried on the status record. Verified 2026-09-21:
     intasend-collections (refuses because probing would move money), algolia
     (needs a secret bound to the probe function) and cloudflare (no executor
     at all) are INDISTINGUISHABLE here — identical health, identical
     capabilities, identical note.

     So the branch is implemented and certified against a record that supplies
     the field, and in production it simply never matches; those rails render
     NOT PROBED, which is true but less precise than it could be. Inventing the
     distinction from `capabilities` would be a guess wearing the authority of a
     measurement — the absence of `test` conflates four separate reasons. The
     fix is one field on the status resolver, and it is out of this scope. */

  var CHIP_META = {
    live:        { label: 'LIVE',              cls: 'healthy'  },
    active:      { label: 'ACTIVE',            cls: 'healthy'  },
    stale:       { label: 'STALE',             cls: 'warn'     },
    degraded:    { label: 'DEGRADED',          cls: 'degraded' },
    failed:      { label: 'FAILED',            cls: 'error'    },
    gated:       { label: 'GATED',             cls: 'unknown'  },
    unconfigured:{ label: 'NOT CONFIGURED',    cls: 'error'    },
    refused:     { label: 'REFUSED BY DESIGN', cls: 'unknown'  },
    unprobed:    { label: 'NOT PROBED',        cls: 'unknown'  },
    unreadable:  { label: 'EVIDENCE UNREADABLE', cls: 'unknown' },
  };

  /* ── THE OPERATOR VOCABULARY ──────────────────────────────────────────
     CHIP_META above is the EVIDENCE state — what was measured. This is the
     OPERATIONAL state — what an operator should do about it. The second is
     DERIVED from the first and never computed independently, so the console
     cannot drift into asserting a health it did not measure.

     WHY THIS IS NOT A SEVEN-STATE VOCABULARY

     The natural operator set is ACTIVE / PARTIAL / INACTIVE / ERROR /
     ACTION REQUIRED / TESTING / QUARANTINED. Three evidence states have no
     honest home in it, and between them they cover most of the catalogue:

       unprobed   31 of 47 entries. Nothing measures this rail. That is NOT
                  "inactive" — most of these are in daily use; they simply have
                  no probe. Rendering them INACTIVE would state, of forty
                  integrations, a fact nobody established.
       refused     9 entries. A probe exists and deliberately will not run
                  (no safe probe, or it needs a secret binding). Refusing is
                  correct behaviour, not disuse.
       unreadable  the status read itself failed. A fact about the console,
                  not about the rail.

     So NOT VERIFIED is added as an eighth chip and REFUSED BY DESIGN keeps its
     own, on the owner's decision of 2026-09-29. The console shows mostly grey
     until probes exist — which is the true state, and the point.

     TESTING is defined and currently unreachable: no evidence state maps to it.
     It stays in the legend rather than being filled by forcing some other state
     into it, because an empty bucket is honest and a mislabelled one is not. */
  var OPS_META = {
    active:    { label: 'ACTIVE',            dot: '🟢', cls: 'healthy'  },
    partial:   { label: 'PARTIAL',           dot: '🟡', cls: 'warn'     },
    inactive:  { label: 'INACTIVE',          dot: '⚪',       cls: 'unknown'  },
    error:     { label: 'ERROR',             dot: '🔴', cls: 'error'    },
    action:    { label: 'ACTION REQUIRED',   dot: '🟠', cls: 'error'    },
    testing:   { label: 'TESTING',           dot: '🔵', cls: 'warn'     },
    quarantine:{ label: 'QUARANTINED',       dot: '⛔',       cls: 'unknown'  },
    unverified:{ label: 'NOT VERIFIED',      dot: '⚫',       cls: 'unknown'  },
    refused:   { label: 'REFUSED BY DESIGN', dot: '⚪',       cls: 'unknown'  },
  };

  /* evidence key -> operator key. Every CHIP_META key MUST appear here; the
     certification suite fails if one is missing, so a new evidence state
     cannot silently fall through to a default that flatters it. */
  var OPS_FROM_EVIDENCE = {
    live:         'active',
    active:       'partial',
    stale:        'partial',
    degraded:     'partial',
    failed:       'error',
    gated:        'quarantine',
    unconfigured: 'action',
    refused:      'refused',
    unprobed:     'unverified',
    unreadable:   'unverified',
  };

  /* `active` -> PARTIAL, deliberately. That evidence state means "operational
     evidence exists somewhere, but no live probe runs here". ACTIVE is reserved
     for a rail a CURRENT probe reached. Promoting evidence-without-a-probe to
     green is precisely the optimism this console exists to refuse. */
  function _opsChip(entry) {
    var ev = _chip(entry);
    if (!ev) return null;
    var key = OPS_FROM_EVIDENCE[ev.key] || 'unverified';
    var m = OPS_META[key];
    return { key: key, label: m.label, dot: m.dot, cls: m.cls,
             evidenceKey: ev.key, evidenceLabel: ev.label, why: ev.why };
  }

  /* Lifecycles that describe a DELIBERATELY closed rail. Mirrors the server's
     NON_PROBEABLE_LIFECYCLES plus `retired`; if that list moves, move this. */
  var GATED_LIFECYCLES = ['quarantined', 'frozen', 'retired'];

  /** The chip for one catalogue entry. Returns { key, label, cls, why }.
      `why` is rendered as the title so the derivation is inspectable rather
      than something an operator has to take on trust. */
  function _chip(entry) {
    if (!entry) return null;
    var r = _statusFor(entry.id);

    /* 1. The read itself failed. Nothing below can be trusted. */
    if (_data.status.ok === false) {
      return _chipOf('unreadable',
        'The integration status could not be read, so no state can be derived. ' +
        'This is a failed read, not a finding about the rail.');
    }

    if (r) {
      /* 2-3. A probe ran and produced an outcome. */
      if (r.health === 'failed') {
        return _chipOf('failed', 'A probe ran and the rail failed or refused the call.');
      }
      if (r.health === 'degraded') {
        return _chipOf('degraded',
          'Reachable, but a stage the rail SUPPORTS came back false. Working in part.');
      }

      /* 4-5. Connected — but is the observation still current? */
      if (r.health === 'connected') {
        var at = _ms(r.probedAt) || _ms(r.checkedAt);
        if (at && (Date.now() - at) > STALE_MS) {
          return _chipOf('stale',
            'It WAS connected, but the observation has aged past the freshness window. ' +
            'An old success is not a current one.');
        }
        return _chipOf('live', 'A current probe reached this rail successfully.');
      }
    }

    /* 6. Deliberately closed. */
    if (GATED_LIFECYCLES.indexOf(entry.status) !== -1) {
      return _chipOf('gated',
        'Deliberately closed (' + entry.status + '). No probe is expected, and ' +
        'reopening it is a decision rather than a fix.');
    }

    /* 7. A credential the rail requires is demonstrably absent. */
    if (r && (r.credentialState === 'missing' || r.credentialState === 'partial')) {
      return _chipOf('unconfigured',
        'A required credential is absent (' + r.credentialState + '). This is a ' +
        'CONFIGURATION fact, not a failed call — nothing was attempted.');
    }

    /* 8. A probe exists and deliberately will not run. Requires a field the
          status record does not yet carry; see the note above. */
    if (r && r.notRunReason) {
      return _chipOf('refused',
        'A probe exists and deliberately will not run (' + r.notRunReason + '). ' +
        'Refusing is the correct behaviour, not a gap.');
    }

    /* 9. Operational evidence exists, but nothing probes it live. */
    if (entry.health && entry.health.source) {
      return _chipOf('active',
        'Operational evidence exists at ' + entry.health.source + ', but no live ' +
        'probe runs against this rail. Catalogued and evidenced, not measured.');
    }

    /* 10. Nothing. */
    return _chipOf('unprobed',
      'No live evidence path exists for this rail. Nothing has been measured, ' +
      'which is NOT the same as something having been measured and found absent.');
  }

  function _chipOf(key, why) {
    var m = CHIP_META[key];
    return { key: key, label: m.label, cls: m.cls, why: why };
  }

  function _chipHtml(entry) {
    var c = _chip(entry);
    if (!c) return '';
    return '<span class="sic-chipstate ' + c.cls + '" title="' + _esc(c.why) + '">' +
           _esc(c.label) + '</span>';
  }

  /** The operator chip, with the evidence state it was derived from kept
      visible beside it. Both are shown because they answer different
      questions: the operator chip says what to do, the evidence chip says what
      was actually observed. Showing only the first would hide the basis; only
      the second asks every operator to learn a ten-state vocabulary. */
  function _opsChipHtml(entry) {
    var o = _opsChip(entry);
    if (!o) return '';
    /* The evidence half REUSES _chipHtml rather than re-rendering the label.
       One renderer, so the two can never disagree — and the certification
       suite keeps reading the same `sic-chipstate` span, with the same `why`
       in its title, that it always did. The operator chip is additive: it did
       not replace the evidence, it sits in front of it. */
    return '<span class="sic-ops ' + o.cls + '" title="' + _esc(o.why) + '">' +
           '<span aria-hidden="true">' + o.dot + '</span> ' + _esc(o.label) + '</span>' +
           _chipHtml(entry);
  }

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
    /* ISO STRINGS. The backend status record carries probedAt/checkedAt as ISO
       strings, not Firestore timestamps — the other callers of this helper pass
       timestamps, which is why the string case was never needed before.

       Returning 0 for a string is not harmless here: the staleness check reads
       `if (at && aged)`, so a zero made the age test unreachable and a CONNECTED
       rail could never go stale. An old success would have kept a green chip
       indefinitely, which is the exact failure the chip was added to prevent.
       Caught by certification on the first run of F1. */
    if (typeof v === 'string') { var t = Date.parse(v); return isNaN(t) ? 0 : t; }
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
      /* Headline tiles — the glance above the breakdown. */
      '.sic-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin:0 0 14px}',
      '.sic-tile{border:1px solid var(--sic-border);border-radius:10px;padding:12px 14px;background:rgba(255,255,255,.02)}',
      '.sic-tile-v{font-size:26px;font-weight:700;line-height:1.05;font-variant-numeric:tabular-nums}',
      '.sic-tile-k{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--sic-muted);margin-top:3px}',
      /* An unknown is dimmed AND em-dashed: it must not read as a big zero. */
      '.sic-tile-dead{color:var(--sic-muted);font-weight:500}',
      '.sic-tile.good .sic-tile-v{color:#2ecc71}',
      '.sic-tile.warn .sic-tile-v{color:#d8a13a}',
      '.sic-tile.bad  .sic-tile-v{color:#e05252}',
      /* The integration table. Inherits sic-table; only what differs is here. */
      '.sic-itable{min-width:940px}',
      '.sic-itable td{vertical-align:middle}',
      '.sic-irow{cursor:pointer}',
      '.sic-irow.on{background:rgba(255,255,255,.06);box-shadow:inset 2px 0 0 var(--sic-accent,#2ecc71)}',
      '.sic-row-i{font-size:17px;margin-right:9px;vertical-align:middle}',
      '.sic-row-id{display:inline-block;vertical-align:middle;max-width:34ch}',
      '.sic-row-id b{display:block;font-weight:600}',
      '.sic-row-id i{display:block;font-style:normal;font-size:11px;color:var(--sic-muted)}',
      /* The operator note — MUTED, not alarming. 50 of 60 entries carry one, so
         an amber warning rule would flag 83% of the table and mean nothing. The
         status chip carries state; this carries context. */
      '.sic-rownote{display:block;margin-top:4px;font-size:11px;line-height:1.45;',
      'color:var(--sic-muted);opacity:.78;max-width:64ch}',
      '.sic-none{color:var(--sic-muted);opacity:.65}',
      '.sic-acts{white-space:nowrap}',
      '.sic-act{display:inline-block;font-size:11px;padding:3px 9px;margin-left:6px;border-radius:6px;',
      'border:1px solid var(--sic-border);color:var(--sic-muted)}',
      '.sic-irow:hover .sic-act{color:inherit;border-color:var(--sic-muted)}',
      '@media (max-width:760px){.sic-tile-v{font-size:22px}.sic-row-id{max-width:22ch}}',
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
      /* The observed-state chip. Deliberately typographically distinct from the
         lifecycle badge beside it — they are different claims and must not read
         as one control. Uppercase, tighter, no status dot. */
      '.sic-chipstate{display:inline-block;padding:1px 7px;border-radius:4px;',
      'font-size:10px;font-weight:700;letter-spacing:.04em;border:1px solid;',
      'text-transform:uppercase;white-space:nowrap}',
      '.sic-chipstate.healthy{color:var(--sic-ok);border-color:var(--sic-ok)}',
      '.sic-chipstate.warn{color:var(--sic-warn);border-color:var(--sic-warn)}',
      '.sic-chipstate.degraded{color:var(--sic-warn);border-color:var(--sic-warn)}',
      '.sic-chipstate.error{color:var(--sic-bad);border-color:var(--sic-bad)}',
      '.sic-chipstate.unknown{color:var(--sic-muted);border-color:var(--sic-border)}',
      '.sic-ic-state{margin:2px 0 6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      /* Disagreement queue — the actionable states, worst first. */
      '.sic-dq{border:1px solid var(--sic-line,#2a3348);border-left:3px solid #d8a13a;border-radius:10px;padding:12px 14px;margin:0 0 14px;background:rgba(216,161,58,.06)}',
      '.sic-dq-trip{border-left-color:#e05252;background:rgba(224,82,82,.08)}',
      '.sic-dq-unknown{border-left-color:#6b7488;background:rgba(107,116,136,.06)}',
      '.sic-dq-h{font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px}',
      '.sic-dq-list{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}',
      '.sic-dq-row{font-size:13px;line-height:1.45}',
      '.sic-dq-sev{display:inline-block;font-size:10px;letter-spacing:.06em;font-weight:700;padding:1px 6px;border-radius:4px;background:rgba(216,161,58,.18);color:#d8a13a}',
      '.sic-dq-tripwire .sic-dq-sev{background:rgba(224,82,82,.18);color:#e05252}',
      '.sic-dq-state{text-transform:uppercase;font-size:11px;letter-spacing:.04em;opacity:.85}',
      '.sic-dq-note{margin:3px 0 0;font-size:12px;opacity:.8}',
      '.sic-dq-meta{margin-top:3px;font-size:11px;opacity:.6}',
      '.sic-dq-meta code{font-size:11px}',
      /* Operational dependencies — a separate section, visually distinct. */
      '.sic-opdep .sic-group-h{opacity:.9}',
      '.sic-opdep-note{margin:2px 0 10px;font-size:12px;opacity:.7;max-width:70ch}',
      '.sic-ic-static{cursor:default;text-align:left}',

      /* ── Operator chip + the evidence state it came from ──────────────
         The operator chip is filled; the evidence state beside it is quiet
         text. The visual weight matches the decision weight: act on the
         first, audit with the second. */
      '.sic-ops{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;',
      'border-radius:999px;font-size:10.5px;font-weight:800;letter-spacing:.03em;',
      'text-transform:uppercase;white-space:nowrap;border:1px solid}',
      '.sic-ops.healthy{color:var(--sic-ok);border-color:var(--sic-ok);background:rgba(113,255,0,.08)}',
      '.sic-ops.warn{color:var(--sic-warn);border-color:var(--sic-warn);background:rgba(255,176,32,.08)}',
      '.sic-ops.error{color:var(--sic-bad);border-color:var(--sic-bad);background:rgba(255,92,92,.08)}',
      '.sic-ops.unknown{color:var(--sic-muted);border-color:var(--sic-border)}',
      '.sic-ops-ev{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;',
      'color:var(--sic-muted);white-space:nowrap}',

      /* ── The operational summary header ───────────────────────────────
         Each count is a FILTER, so a number the operator doubts is one click
         from the rows behind it. A total that cannot be opened is a claim;
         one that can is evidence. */
      '.sic-summary{margin:0 0 14px;padding:13px 15px;border-radius:12px;',
      'background:var(--sic-surface,rgba(255,255,255,.03));border:1px solid var(--sic-border)}',
      '.sic-sum-h{font-size:13px;font-weight:800;letter-spacing:-.01em;margin-bottom:9px}',
      '.sic-sum-sub{display:block;font-size:11px;font-weight:500;color:var(--sic-muted);',
      'letter-spacing:0;margin-top:2px}',
      '.sic-sum-chips{display:flex;flex-wrap:wrap;gap:7px}',
      '.sic-sum-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;',
      'border-radius:999px;border:1px solid var(--sic-border);background:transparent;',
      'color:var(--sic-muted);font:inherit;font-size:11px;font-weight:600;cursor:pointer;',
      'transition:border-color .15s,color .15s}',
      '.sic-sum-chip b{font-weight:900;font-size:12px}',
      '.sic-sum-chip:hover{border-color:var(--sic-muted)}',
      '.sic-sum-chip.on{border-color:currentColor}',
      '.sic-sum-chip.healthy{color:var(--sic-ok)}',
      '.sic-sum-chip.warn{color:var(--sic-warn)}',
      '.sic-sum-chip.error{color:var(--sic-bad)}',
      '@media(max-width:560px){.sic-sum-chips{gap:5px}',
      '.sic-sum-chip{padding:3px 8px;font-size:10.5px}}',
      /* A figure that is a way INTO its evidence, not a dead end. Styled as a
         number first and a control second — it must not read as a button that
         does something to the infrastructure. */
      '.sic-linkfig{background:none;border:none;padding:0;font:inherit;font-weight:600;',
      'color:var(--sic-accent);cursor:pointer;text-decoration:underline;',
      'text-underline-offset:2px;text-decoration-style:dotted}',
      '.sic-linkfig:hover{text-decoration-style:solid}',
      '.sic-linkfig:focus-visible{outline:2px solid var(--sic-accent);outline-offset:2px}',
      '.sic-chip.sic-link{cursor:pointer;color:var(--sic-accent);',
      'border-color:var(--sic-accent);background:none}',
      '.sic-chip.sic-link[aria-pressed="true"]{background:var(--sic-accent);color:#fff}',
      /* Evidence tables can be wide — an inventory row carries a digest and a
         service-account email. Scroll the table, never the page. */
      '.sic-scroll{overflow-x:auto;margin:6px 0 2px}',
      '.sic-t{width:100%;border-collapse:collapse;font-size:11.5px}',
      '.sic-t th{text-align:left;padding:5px 8px;border-bottom:1px solid var(--sic-border);',
      'color:var(--sic-muted);font-weight:600;white-space:nowrap}',
      '.sic-t td{padding:5px 8px;border-bottom:1px solid var(--sic-border);white-space:nowrap}',
      '.sic-t tr:hover td{background:var(--sic-surface2)}',
      /* The one write surface gets a visibly different treatment. A control
         that CHANGES access must not look like a control that reads it. */
      '.sic-card.sic-danger{border-color:rgba(244,67,54,.5)}',
      '.sga-in{width:100%;box-sizing:border-box;padding:7px 9px;margin:4px 0;',
      'background:var(--sic-surface2);border:1px solid var(--sic-border);',
      'border-radius:6px;color:var(--sic-text);font-size:12.5px;font-family:inherit}',
      '.sga-btn{padding:6px 12px;border-radius:6px;border:1px solid var(--sic-border);',
      'background:var(--sic-surface2);color:var(--sic-text);font-size:12px;cursor:pointer}',
      '.sga-btn:hover{border-color:var(--sic-accent)}',
      '.sga-btn[disabled]{opacity:.45;cursor:not-allowed}',
      '.sga-btn.danger{border-color:rgba(244,67,54,.6);color:#f44336}',
      /* The relationship graph. A node whose reading failed is DIMMED rather
         than removed — an absent box would read as "no such thing". */
      '.sg{max-width:100%;height:auto}',
      '.sg .sg-n rect{fill:var(--sic-surface2);stroke:var(--sic-border);stroke-width:1}',
      '.sg .sg-n text{fill:var(--sic-text);font-size:11px;font-family:inherit}',
      '.sg .sg-n .sg-v{fill:var(--sic-accent);font-size:12px;font-weight:600}',
      '.sg .sg-n:hover rect{stroke:var(--sic-accent)}',
      '.sg .sg-n:focus-visible rect{stroke:var(--sic-accent);stroke-width:2}',
      '.sg .sg-n.dead rect{opacity:.45;stroke-dasharray:3 3}',
      '.sg .sg-n.dead .sg-v{fill:var(--sic-muted)}',
      '.sg .sg-e{fill:none;stroke:var(--sic-border);stroke-width:1.5}',

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

  /* ══ OBSERVED ACTIVITY ANALYTICS ══════════════════════════════════════
     Most rails on this platform expose no health endpoint, so the catalogue
     correctly refuses to guess at their health. That leaves a real question
     unanswered: is anything actually HAPPENING on this rail?

     There is a canonical way to ask without inventing anything. Each entry
     declares the collections it writes. Those collections live in Firestore,
     an admin can read them, and what they contain is a fact rather than an
     inference. So for a selected integration this measures, per declared
     collection: how many documents a bounded read returned, and when the most
     recent one was written.

     WHAT THIS IS NOT
     ----------------
     It is NOT a health verdict, and it is NOT attributed to the rail. A
     collection is shared — `orders` is written by checkout, by POS and by
     admin tooling. Recent documents in a rail's declared collection prove
     activity IN THAT COLLECTION, not that the rail produced it. Every label
     rendered from this data says so. Reading it as "the rail is healthy" is
     the exact mistake this console exists to prevent.

     IT IS ALSO NOT A BUSINESS METRIC. These are operational document counts
     over an explicitly stated bound, never revenue, never order volume, and
     never a figure to put on a dashboard tile.

     COST
     ----
     This runs ON DEMAND, only for the integration an operator opened, never
     for all 35 at load. Reads are capped per collection and the number of
     collections examined is capped too, so opening a card has a known ceiling
     rather than an open-ended one.

     UNKNOWN STAYS UNKNOWN
     ---------------------
     A read that fails records the failure and names it. A collection with no
     timestamped document reports that it has none. Neither ever becomes a
     zero, and neither ever becomes a dash that pretends nothing was tried. */

  var ANALYTIC_CAP       = 50;   /* documents sampled per collection */
  var ANALYTIC_MAX_COLLS = 6;    /* collections examined per integration */
  var SDK_BASE = 'https://www.gstatic.com/firebasejs/10.12.2/';

  /* Fields tried, in order, when asking "when was the most recent write?".
     The first one that yields a document wins. A collection that answers to
     none of them is reported as having no readable timestamp — which is a
     finding about the collection, not a failure of the probe. */
  var TIME_FIELDS = ['createdAt', 'updatedAt', 'timestamp', 'created_at'];

  /* id -> { state, colls, db, error }.  state: idle | running | done */
  var _analytics = {};

  /** A handle for a named Firestore database.
      The compat layer this console runs on is bound to the default database and
      cannot address a second one, so a named database is reached through the
      modular SDK directly. Both handles are then used through the same tiny
      surface — collection(p).limit(n).get() and .orderBy(f,d).limit(n).get() —
      whose snapshots agree on `size` and on `docs[i].data()`.

      Injectable at mount so certification can drive this without a network. */
  function _namedDb(dbId) {
    if (typeof _opts.getNamedDb === 'function') {
      try { return Promise.resolve(_opts.getNamedDb(dbId)); }
      catch (e) { return Promise.reject(e); }
    }
    if (!dbId || dbId === '(default)') {
      var d = _db();
      return d ? Promise.resolve(d)
               : Promise.reject(new Error('Firestore is not initialised on this page.'));
    }
    if (typeof window === 'undefined') {
      return Promise.reject(new Error('No browser context for a named-database read.'));
    }
    return Promise.all([
      import(SDK_BASE + 'firebase-app.js'),
      import(SDK_BASE + 'firebase-firestore.js'),
    ]).then(function (m) {
      var f  = m[1];
      var db = f.getFirestore(m[0].getApp(), dbId);
      function q(path, constraints) {
        return f.getDocs(f.query.apply(null, [f.collection(db, path)].concat(constraints)));
      }
      return {
        collection: function (path) {
          return {
            limit: function (n) {
              return { get: function () { return q(path, [f.limit(n)]); } };
            },
            orderBy: function (fl, dir) {
              return { limit: function (n) {
                return { get: function () { return q(path, [f.orderBy(fl, dir), f.limit(n)]); } };
              } };
            },
          };
        },
      };
    });
  }

  /** Most recent write in a collection, or an honest account of why not.
      Resolves { at, field } on success, { at: null, reason } otherwise. */
  function _latest(db, path, fields) {
    var list = fields || TIME_FIELDS;
    if (!list.length) return Promise.resolve({ at: null, reason: 'no readable timestamp field' });
    var field = list[0];
    return db.collection(path).orderBy(field, 'desc').limit(1).get()
      .then(function (snap) {
        if (snap && snap.size) {
          var row = snap.docs[0].data() || {};
          var at  = _ms(row[field]);
          if (at) return { at: at, field: field };
        }
        return _latest(db, path, list.slice(1));
      })
      .catch(function () { return _latest(db, path, list.slice(1)); });
  }

  /** One collection's observed state. Never throws; a failure is a value. */
  function _analyseCollection(db, path) {
    return db.collection(path).limit(ANALYTIC_CAP).get()
      .then(function (snap) {
        var n = (snap && typeof snap.size === 'number') ? snap.size : 0;
        return _latest(db, path).then(function (l) {
          return {
            name:    path,
            ok:      true,
            /* At the cap the true total is unknown — say "at least", never a
               bare number that reads as a complete count. */
            atLeast: n >= ANALYTIC_CAP,
            docs:    n,
            latest:  l.at,
            field:   l.field || '',
            reason:  l.reason || '',
            error:   '',
          };
        });
      })
      .catch(function (e) {
        return { name: path, ok: false, docs: null, latest: null,
                 error: (e && e.message) || 'Read failed.' };
      });
  }

  /** Reachability of a declared database. A database is reachable when a
      bounded read RETURNS — an empty result is a successful read, and proves
      the database answers and the rules permit it. It does NOT prove the
      database is in use, and it does NOT prove it is empty. */
  function _probeDatabase(spec) {
    return _namedDb(spec.id)
      .then(function (db) {
        return db.collection(spec.probe).limit(1).get().then(function (snap) {
          return { state: 'reachable', id: spec.id, probe: spec.probe,
                   empty: !(snap && snap.size), error: '' };
        });
      })
      .catch(function (e) {
        var msg = (e && e.message) || String(e);
        var denied = /permission|insufficient|PERMISSION_DENIED/i.test(msg);
        return { state: denied ? 'denied' : 'unreachable', id: spec.id,
                 probe: spec.probe, empty: null, error: msg };
      });
  }

  /** Measure one integration, on demand. Idempotent per id. */
  function _analyse(id) {
    var c = _cat();
    var e = c && c.lookup ? c.lookup(id) : null;
    if (!e) return Promise.resolve();
    if (_analytics[id] && _analytics[id].state !== 'idle') return Promise.resolve();

    var colls = ((e.evidence || {}).collections || []).slice(0, ANALYTIC_MAX_COLLS);
    var spec  = e.database || null;
    if (!colls.length && !spec) {
      _analytics[id] = { state: 'done', colls: [], db: null, capped: 0, error: '' };
      return Promise.resolve();
    }

    _analytics[id] = { state: 'running', colls: [], db: null, capped: 0, error: '' };
    _render();

    /* A rail's own collections are read from the database it belongs to; every
       rail other than the two database entries writes the default database. */
    return _namedDb(spec ? spec.id : '(default)')
      .then(function (db) {
        return Promise.all(colls.map(function (p) { return _analyseCollection(db, p); }));
      })
      .catch(function (err) {
        _analytics[id].error = (err && err.message) || 'Database unavailable.';
        return [];
      })
      .then(function (rows) {
        return (spec ? _probeDatabase(spec) : Promise.resolve(null))
          .then(function (dbState) {
            var total = ((e.evidence || {}).collections || []).length;
            _analytics[id].colls  = rows;
            _analytics[id].db     = dbState;
            _analytics[id].capped = Math.max(0, total - colls.length);
            _analytics[id].state  = 'done';
            _render();
          });
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
                         inventoryReadable: st.data.inventoryReadable,
                         /* ── THE ACTIONABLE QUEUE, TAKEN VERBATIM ──────────
                            The resolver decides which disagreements need
                            acting on; this surface renders that decision and
                            does not re-derive it. Recomputing it here would
                            create a second opinion about what is urgent, and
                            the two would eventually disagree — with the
                            operator unable to tell which was right. An absent
                            array is an EMPTY queue, never an unknown one. */
                         disagreements: st.data.disagreements || [] };
      } else {
        _data.status = { ok: false, byId: {}, counts: {},
                         error: st.error || 'Status unavailable.',
                         checkedAt: '', inventoryReadable: null,
                         /* A failed read yields NO queue rather than an empty
                            one that would read as "nothing is wrong". */
                         disagreements: null };
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

    /* The GCP pill counts DATABASES OBSERVED, not databases declared. It is EM
       until the reader answers, because a count of what we believe exists is
       not a count of what was seen. */
    var gcpN  = (_gcp.state === 'done' && _gcp.data)
      ? String(Object.keys(_gcp.data.databases || {}).length) : EM;

    var defs = [
      ['catalogue',    'Catalogue',    catN],
      ['gcp',          'Google Cloud', gcpN],
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

  /* ── OPERATIONAL SUMMARY ──────────────────────────────────────────────
     Counted from the SAME derivation the cards use, never from a separate
     tally. A header that counted independently could disagree with the grid
     beneath it, and the operator would have no way to tell which lied. */
  function _opsCounts() {
    var c = _cat();
    if (!c) return null;
    var out = { _total: 0 };
    Object.keys(OPS_META).forEach(function (k) { out[k] = 0; });
    c.integrations.forEach(function (i) {
      var ch = _opsChip(i);
      if (!ch) return;
      out[ch.key]++; out._total++;
    });
    return out;
  }

  /* ── HEADLINE TILES ────────────────────────────────────────────────────
     The glance, before anything is read. The chip row below stays the full
     breakdown and the filter control.

     NO NEW TAXONOMY — each tile GROUPS existing ops states, declared here so
     nothing acquires a meaning the evidence model did not give it:

       Healthy       active              observed working
       Attention     action + error      unconfigured or failing
       Unverified    unverified          measurable, never established
       Disagreements the resolver's own  declaration vs observation conflict

     `refused` and `quarantine` are in NO tile, deliberately. A rail that
     refuses by design and one deliberately quarantined are CORRECT states;
     counting them as attention would manufacture work out of decisions already
     taken. Both stay visible in the chip row.

     Every number is counted from the catalogue at render time — nothing here
     hardcodes a total, so a 61st integration counts itself. */
  function _statTiles() {
    var n = _opsCounts();
    if (!n) return '';
    var st = _data.status;
    var dq = (st && st.ok && Array.isArray(st.disagreements)) ? st.disagreements.length : null;

    var tiles = [
      { label: 'Healthy',       v: n.active || 0, cls: 'good',
        hint: 'Observed working — from evidence, not from being configured.' },
      { label: 'Attention',     v: (n.action || 0) + (n.error || 0), cls: 'warn',
        hint: 'Unconfigured or failing. An operator has something to do.' },
      { label: 'Unverified',    v: n.unverified || 0, cls: 'muted',
        hint: 'Measurable in principle; nothing has established it yet.' },
      /* null, NOT 0. An unread status is not "no disagreements", and keeping
         those apart is the distinction this console exists for. */
      { label: 'Disagreements', v: dq, cls: dq ? 'bad' : 'muted',
        hint: dq === null ? 'The status read failed, so no comparison was possible.'
                          : 'Declaration and observation conflict.' },
    ];

    return '<div class="sic-tiles">' + tiles.map(function (t) {
      var dead = (t.v === null || t.v === undefined);
      return '<div class="sic-tile ' + t.cls + '" title="' + _esc(t.hint) + '">' +
        '<div class="sic-tile-v' + (dead ? ' sic-tile-dead' : '') + '">' +
          (dead ? '—' : t.v) + '</div>' +
        '<div class="sic-tile-k">' + _esc(t.label) + '</div></div>';
    }).join('') + '</div>';
  }

  /* ── THE INTEGRATION TABLE ─────────────────────────────────────────────
     Built on the console's EXISTING table — the same sic-card / sic-scroll /
     sic-table / thead / tbody structure the Secrets, Registered, Capabilities
     and Dependencies views already use. A second table system styled from
     scratch would have looked identical and drifted within a month.

     WHY A TABLE AND NOT THE CARD GRID. With 60 entries — 29 of them
     infrastructure — a grid makes an operator scroll to compare, and comparison
     is the job. Category becomes a COLUMN rather than a heading, so the whole
     estate reads in one pass.

     COLUMNS THE PLATFORM CANNOT HONESTLY FILL ARE NOT INVENTED. An
     events-per-day column is the obvious thing to want here and there is no
     event count anywhere in this model, so there is none. `Environment` and
     `Last verified` DO exist on the record but are null until a probe records
     them, and they render `—`. Never `0`, never "Production" by assumption: an
     unknown drawn as a value is the defect this console exists to prevent.

     In place of events, `Evidence` shows what actually established the entry,
     which is real and is what an operator is really asking. */
  function _table(rows) {
    if (!rows.length) {
      return '<div class="sic-card"><div class="sic-empty">' +
        'No integration matches these filters.</div></div>';
    }
    var cats = _cat().categories;
    var total = _cat().integrations.length;

    return '<div class="sic-card"><div class="sic-scroll">' +
      '<table class="sic-table sic-itable">' +
      '<thead><tr>' +
        '<th>Integration</th><th>Category</th><th>Environment</th>' +
        '<th>Status</th><th>Last verified</th><th>Evidence</th><th>Actions</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (i) {
        var r   = _statusFor(i.id);
        var cat = cats.find(function (k) { return k.id === i.category; }) || {};
        var ev  = i.evidence || {};
        var nEv = (ev.modules || []).length + (ev.endpoints || []).length +
                  (ev.collections || []).length;
        var caps = (r && r.capabilities) || [];
        var seen = _lastVerified(i);
        /* The record's own declared environment, or nothing. Never inferred. */
        var env  = (r && r.environment) ? r.environment : null;
        var sel  = (_selKind === 'catalogue' && _selected === i.id);
        var none = function (why) {
          return '<span class="sic-none" title="' + _esc(why) + '">—</span>';
        };

        return '<tr class="sic-irow' + (sel ? ' on' : '') + '" aria-selected="' + sel + '" ' +
          'onclick="SokoniIntegrations.selectCatalogue(\'' + _esc(i.id) + '\')">' +

          '<td><span class="sic-row-i" aria-hidden="true">' + i.icon + '</span>' +
            '<span class="sic-row-id"><b class="sic-name">' + _esc(i.name) + '</b>' +
            '<i>' + _esc(i.vendor) + '</i></span>' +
            /* The operator note, where the catalogue carries one. This is where
               osrm-routing says its provider is a public demo server with no
               SLA, and google-charts-image says it is vendor-deprecated —
               facts that must not be flattened under the same treatment as a
               healthy rail. Rendered from the catalogue's own prose; nothing
               here classifies risk. */
            (i.notes ? '<span class="sic-rownote" title="' + _esc(i.notes) + '">' +
              _esc(i.notes.length > 132 ? i.notes.slice(0, 132).replace(/s+S*$/, '') + '…' : i.notes) +
              '</span>' : '') +
          '</td>' +

          '<td><span class="sic-chip">' + _esc(cat.label || i.category) + '</span></td>' +

          '<td>' + (env ? '<span class="sic-chip">' + _esc(env) + '</span>'
                        : none('No environment has been declared for this record.')) + '</td>' +

          '<td>' + _opsChipHtml(i) + '</td>' +

          '<td>' + (seen || none('Never verified — no probe has recorded a result.')) + '</td>' +

          '<td>' + (nEv
            ? '<span class="sic-sig muted" title="' +
                _esc((ev.modules || []).concat(ev.endpoints || []).slice(0, 6).join(' · ')) +
                '">' + nEv + ' source' + (nEv === 1 ? '' : 's') + '</span>'
            : none('No modules or endpoints are declared for this entry.')) +
            ((ev.secrets || []).length
              ? ' <span class="sic-sig muted" title="Credential NAMES only; no value is ever read.">' +
                ev.secrets.length + ' secret' + (ev.secrets.length === 1 ? '' : 's') + '</span>'
              : '') + '</td>' +

          '<td class="sic-acts">' +
            (caps.indexOf('test') > -1
              ? '<span class="sic-act" title="A probe exists for this rail and would actually run.">Test</span>'
              : '') +
            '<span class="sic-act">Open</span>' +
          '</td></tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<p class="sic-note">Showing ' + rows.length + ' of ' + total + ' integrations' +
        (rows.length === total ? '' : ' · filtered') +
        '. <em>Environment</em> and <em>Last verified</em> show <span class="sic-mono">—</span> ' +
        'until a probe records one; they are not defaults. There is no events column because the ' +
        'platform measures no event volume — an invented number would be worse than an absent one.' +
      '</p></div>';
  }

  /* ── THE ACTIONABLE DISAGREEMENT QUEUE ─────────────────────────────────
     Driven ONLY by the resolver's top-level `disagreements` array. This
     surface does not decide what is urgent; the resolver already did, against
     the ratified matrix, with a suite behind it. Re-deriving the queue here
     would create a second opinion — and when the two drifted, the operator
     would have no way to tell which was right.

     THREE DISTINCT RENDERINGS, AND THE DIFFERENCE MATTERS:

       queue is null     the status read FAILED. Nothing is claimed.
       queue is []       the resolver ran and found nothing to act on. QUIET.
       queue has rows    these need attention, worst first.

     An absent queue rendered as "all clear" is the defect this whole surface
     exists to prevent, so the null case says it could not check. */
  function _disagreementQueue() {
    var st = _data.status;
    if (!st) return '';
    if (!st.ok || st.disagreements === null) {
      return '<div class="sic-dq sic-dq-unknown"><div class="sic-dq-h">' +
        '<span aria-hidden="true">—</span> Disagreements could not be checked</div>' +
        '<p class="sic-dq-note">The status read failed, so no comparison between what each ' +
        'integration DECLARES and what was OBSERVED could be made. This is not an all-clear.</p></div>';
    }
    var rows = st.disagreements || [];
    if (!rows.length) return '';    /* quiet: no banner, no reassuring claim */

    /* Worst first. A money-rail tripwire must never sort below a stale label. */
    var ORDER = { tripwire: 0, action: 1 };
    var sorted = rows.slice().sort(function (a, b) {
      return (ORDER[a.severity] === undefined ? 9 : ORDER[a.severity]) -
             (ORDER[b.severity] === undefined ? 9 : ORDER[b.severity]);
    });
    var trip = sorted.filter(function (d) { return d.severity === 'tripwire'; }).length;

    return '<div class="sic-dq' + (trip ? ' sic-dq-trip' : '') + '">' +
      '<div class="sic-dq-h">' +
      '<span aria-hidden="true">' + (trip ? '⚠' : '◆') + '</span> ' +
      _esc(String(sorted.length)) + ' integration' + (sorted.length === 1 ? '' : 's') +
      ' disagree' + (sorted.length === 1 ? 's' : '') + ' with ' +
      (sorted.length === 1 ? 'its' : 'their') + ' declaration' +
      (trip ? ' · ' + trip + ' SAFETY TRIPWIRE' + (trip === 1 ? '' : 'S') : '') +
      '</div>' +
      '<ul class="sic-dq-list">' + sorted.map(function (d) {
        return '<li class="sic-dq-row sic-dq-' + _esc(d.severity) + '">' +
          '<span class="sic-dq-sev">' + _esc(String(d.severity).toUpperCase()) + '</span> ' +
          '<strong>' + _esc(d.name || d.id) + '</strong> — ' +
          '<span class="sic-dq-state">' + _esc(String(d.state).replace(/-/g, ' ')) + '</span>' +
          '<div class="sic-dq-note">' + _esc(d.note || '') + '</div>' +
          '<div class="sic-dq-meta">declared <code>' + _esc(String(d.declared)) + '</code>' +
          ' · observed <code>' + _esc(String(d.observed)) + '</code>' +
          (d.probedAt ? ' · probed ' + _esc(String(d.probedAt).slice(0, 19)).replace('T', ' ') : '') +
          '</div></li>';
      }).join('') + '</ul></div>';
  }

  /* ── OPERATIONAL DEPENDENCIES — A SEPARATE SECTION, ON PURPOSE ──────────
     Providers the BUSINESS relies on and the CODE does not talk to. They come
     from a DIFFERENT catalogue collection and are rendered in a DIFFERENT
     section, because they are a different kind of fact.

     THEY MUST NOT REUSE AN EVIDENCE-MODEL STATE. `unknown`, NOT VERIFIED and
     REFUSED BY DESIGN all describe our MEASUREMENT of something measurable.
     NOT PROBEABLE describes the RELATIONSHIP: there is no SOKONI code path, so
     there is nothing to measure and never will be. Rendering one as the other
     would tell an operator to go and check something that cannot be checked.

     Nothing here is passed through the technical status resolver, and the
     registry refuses an evidence record for these ids in any case. */
  function _operationalSection() {
    var c = _cat();
    var deps = (c && c.operationalDependencies) || [];
    if (!deps.length) return '';
    return '<div class="sic-group sic-opdep"><div class="sic-group-h">' +
      '<span class="sic-group-i" aria-hidden="true">🏢</span>Operational dependencies' +
      '<span class="sic-pill">' + deps.length + '</span></div>' +
      '<p class="sic-opdep-note">The business relies on these. SOKONI’s code does not talk to ' +
      'them, so there is no probe path — which is different from a probe that has not run.</p>' +
      '<div class="sic-grid">' + deps.map(function (d) {
        return '<div class="sic-ic sic-ic-static" data-opdep="' + _esc(d.id) + '">' +
          '<div class="sic-ic-top">' +
          '<span class="sic-ic-icon" aria-hidden="true">' + (d.icon || '🏢') + '</span>' +
          '<div class="sic-ic-id"><div class="sic-name">' + _esc(d.name) + '</div>' +
          '<div class="sic-sub">' + _esc(d.vendor || '') + '</div></div>' +
          '</div>' +
          '<div class="sic-ic-state">' +
          '<span class="sic-chip unknown" data-sic-opdep-state="not-probeable">' +
          '<span class="sic-dot"></span>NOT PROBEABLE</span>' +
          '<span class="sic-sig muted">No SOKONI probe path</span>' +
          '</div>' +
          '<p class="sic-ic-sum">' + _esc(d.summary || '') + '</p>' +
          (d.whyNotAnIntegration
            ? '<p class="sic-ic-sum muted">' + _esc(d.whyNotAnIntegration) + '</p>' : '') +
          '<div class="sic-ic-foot">' +
          (d.authority ? '<span class="sic-sig muted">Authority: ' + _esc(d.authority) + '</span>' : '') +
          '</div></div>';
      }).join('') + '</div></div>';
  }

  /** The header. Shows only NON-ZERO states: an empty bucket is noise, and
      TESTING is currently unreachable by design (see OPS_META). */
  function _opsSummary() {
    var n = _opsCounts();
    if (!n) return '';
    var order = ['active', 'partial', 'action', 'error', 'refused', 'quarantine',
                 'unverified', 'inactive', 'testing'];
    var parts = order.filter(function (k) { return n[k] > 0; }).map(function (k) {
      var m = OPS_META[k];
      var on = _filter.ops === k;
      return '<button class="sic-sum-chip' + (on ? ' on' : '') + ' ' + m.cls + '" ' +
        'aria-pressed="' + on + '" title="' + _esc(m.label) + ' — click to filter" ' +
        'onclick="SokoniIntegrations.filter({ops:' + (on ? "''" : "'" + k + "'") + '})">' +
        '<span aria-hidden="true">' + m.dot + '</span> ' +
        '<b>' + n[k] + '</b> ' + _esc(m.label) + '</button>';
    }).join('');
    return '<div class="sic-summary">' +
      '<div class="sic-sum-h">Integrations<span class="sic-sum-sub">' + n._total +
      ' catalogued · state derived from evidence, never from the card existing</span></div>' +
      '<div class="sic-sum-chips">' + parts +
      (_filter.ops ? '<button class="sic-sum-chip" onclick="SokoniIntegrations.filter({ops:\'\'})">' +
        'Clear</button>' : '') + '</div></div>';
  }

  /** Last verified, from the status record only. Never a rendering timestamp:
      "when this page drew" is not "when the rail was checked". */
  function _lastVerified(entry) {
    var r = _statusFor(entry.id);
    var at = r ? (_ms(r.probedAt) || _ms(r.checkedAt)) : 0;
    if (!at) return '<span class="sic-sig muted">Not recently verified</span>';
    var days = Math.floor((Date.now() - at) / 86400000);
    var rel = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago';
    return '<span class="sic-sig" title="' + _esc(new Date(at).toISOString()) + '">' +
      'Verified ' + rel + '</span>';
  }

  function _catRows() {
    var c = _cat();
    if (!c) return [];
    var q = _filter.q.trim().toLowerCase();
    return c.integrations.filter(function (i) {
      if (_filter.type && i.category !== _filter.type) return false;
      if (_filter.status && i.status !== _filter.status) return false;
      if (_filter.ops) {
        var ch = _opsChip(i);
        if (!ch || ch.key !== _filter.ops) return false;
      }
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
      return _opsSummary() +
        '<div class="sic-card"><div class="sic-empty">No integration matches these filters.</div></div>';
    }

    /* Group into the catalogue's own category order, skipping empty groups. */
    return _disagreementQueue() + _statTiles() + _opsSummary() +
      _table(rows) + _operationalSection();
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

  /* ══ GOOGLE CLOUD CONTROL PLANE ══════════════════════════════════════
     GCP is not one provider among forty-seven — it is the substrate the
     platform runs on. This tab COMPOSES the GCP entries the catalogue already
     addresses individually, so an operator can see the infrastructure as one
     estate without the individual rows losing their identity.

     EVERY FIGURE IS AN OBSERVATION, NOT A NUMBER.
     The reader returns { value, state, source, observedAt, reason } per field
     and this renders the STATE as prominently as the value. Six states, none
     collapsible into another:

       observed        read succeeded, the value is real
       empty           read succeeded, found nothing. A MEASURED zero
       unreadable      read failed. Shows an em dash and names the error
       not-attempted   nothing looked. Em dash, and says so
       not-applicable  the question does not apply
       stale           observed, but older than the freshness window

     The distinction this surface exists to preserve is the one between a
     MEASURED zero and an UNMEASURED one. "sokoni-ops has 0 root collections" is
     a real, valuable finding when a server enumerated them and found none. The
     identical glyph produced by a failed read would be a lie. They are rendered
     differently, and certification fails if they stop being. */

  var _gcp = { state: 'idle', data: null, error: '' };

  var OBS_META = {
    observed:         { cls: 'healthy', label: 'Observed' },
    empty:            { cls: 'healthy', label: 'Measured zero' },
    stale:            { cls: 'warn',    label: 'Stale' },
    unreadable:       { cls: 'error',   label: 'Unreadable' },
    'not-attempted':  { cls: 'unknown', label: 'Not measured' },
    'not-applicable': { cls: 'unknown', label: 'Not applicable' },
  };

  /** The rendered value of one observation. Never returns a bare number for a
      state that did not measure one. */
  function _obsValue(o) {
    if (!o || !o.state) return EM;
    if (o.state === 'observed' || o.state === 'empty' || o.state === 'stale') {
      if (o.value === null || o.value === undefined) return EM;
      if (typeof o.value === 'object') return _esc(JSON.stringify(o.value));
      return _esc(String(o.value));
    }
    return EM;
  }

  function _obsBadge(o) {
    var m = OBS_META[(o && o.state) || 'not-attempted'] || OBS_META['not-attempted'];
    return '<span class="sic-badge ' + m.cls + '"><span class="sic-dot"></span>' +
           _esc(m.label) + '</span>';
  }

  /** One metric row. `to` optionally makes the figure open the catalogue entry
      that owns it, so a number is a way INTO the evidence rather than a dead
      end. */
  function _metric(label, o, to) {
    var v = _obsValue(o);
    var shown = to && v !== EM
      ? '<button class="sic-linkfig" onclick="SokoniIntegrations.selectCatalogue(\'' +
        _esc(to) + '\')">' + v + '</button>'
      : v;
    var why = (o && (o.state === 'unreadable' || o.state === 'not-attempted') && o.reason)
      ? '<p class="sic-note">' + _esc(o.reason) + '</p>' : '';
    return '<div class="sic-kv"><span>' + _esc(label) + '</span><strong>' + shown +
           ' ' + _obsBadge(o) + '</strong></div>' + why;
  }

  /* Which GCP drill-down is open. In-panel selection, because AdminOS has no
     router — see the navigation note in the docs. */
  var _gcpDrill = null;

  /** A table over an inventory observation. Renders the cap honestly: a
      truncated list must never read as a complete one. */
  function _invTable(obs, cols, rowKey) {
    if (!obs) return '<p class="sic-note">' + EM + ' Not measured.</p>';
    if (obs.state === 'unreadable') {
      return '<p class="sic-note"><strong>Unreadable.</strong> ' + _esc(obs.reason) +
             ' No rows are shown, because none were obtained.</p>';
    }
    if (obs.state === 'not-attempted') {
      return '<p class="sic-note">' + EM + ' ' + _esc(obs.reason) + '</p>';
    }
    var rows = obs.value || [];
    if (!rows.length) {
      return '<p class="sic-note"><strong>Measured zero.</strong> The read returned no rows. ' +
             'That is a finding, not a failed read.</p>';
    }
    var head = '<tr>' + cols.map(function (c) {
      return '<th>' + _esc(c[0]) + '</th>'; }).join('') + '</tr>';
    var body = rows.map(function (r) {
      return '<tr' + (rowKey ? ' class="' + _esc(rowKey(r)) + '"' : '') + '>' +
        cols.map(function (c) {
          var v = c[1](r);
          /* A column may return { html } to emit markup the console itself
             built — currently only the button that opens an entity's card.
             EVERY other value is escaped. The opt-in is deliberately a
             different SHAPE rather than a flag, so a hostile string from a
             read can never satisfy it: a value from an API is a string or a
             number, never an object with an `html` property this code put
             there. C1 still proves a hostile field is escaped. */
          if (v && typeof v === 'object' && typeof v.html === 'string') return '<td>' + v.html + '</td>';
          return '<td class="sic-mono">' + (v === null || v === undefined || v === ''
            ? EM : _esc(String(v))) + '</td>';
        }).join('') + '</tr>';
    }).join('');
    var cap = obs.truncated
      ? '<p class="sic-note"><strong>Showing ' + rows.length + ' of ' + obs.total +
        '.</strong> The list is capped at ' + obs.cap + ' so a console request stays bounded. ' +
        'The total above is the real total; this table is not.</p>'
      : '';
    return '<div class="sic-scroll"><table class="sic-t">' + head + body + '</table></div>' + cap;
  }

  function _gcpSection(title, body) {
    return '<div class="sic-card"><div class="sic-group-h">' + _esc(title) + '</div>' + body + '</div>';
  }

  function _gcpDatabase(id, db) {
    if (!db) return '';
    return '<div class="sic-sect-l">' + _esc(id) + '</div>' +
      _metric('Region', db.region) +
      _metric('Type', db.type) +
      _metric('Deletion protection', db.deleteProtection) +
      _metric('Indexes deployed', db.indexesDeployed, 'firestore-indexes') +
      _metric('Indexes READY', db.indexesReady, 'firestore-indexes') +
      _metric('Indexes declared in the repo', db.indexesDeclared) +
      _metric('Declared minus deployed', db.indexDrift) +
      _metric('Root collections', db.rootCollections,
              id === 'sokoni-ops' ? 'firestore-sokoni-ops' : 'firestore') +
      /* The sentence that stops the most likely misreading of this panel. */
      (db.rootCollections && db.rootCollections.state === 'empty'
        ? '<p class="sic-note"><strong>This zero was measured.</strong> The server enumerated ' +
          'root collections and found none. That is a finding, and it is not the same as the ' +
          'em dash a browser shows — a client cannot enumerate collections at all.</p>'
        : '');
  }

  /* One entity opened from inside a drill-down table: { kind, id }. */
  var _gcpPick = null;

  /** A row whose first cell opens that entity's own card. */
  function _pickCell(kind, id, label) {
    return '<button class="sic-linkfig" onclick="SokoniIntegrations.gcpPick(\'' +
           _esc(kind) + '\',\'' + _esc(String(id)) + '\')">' + _esc(label) + '</button>';
  }

  /** A small verdict line. `ok` true renders a tick, false a warning, and
      null an em dash — because "not checked" is not "passed". */
  function _check(passed, yes, no, unknown) {
    if (passed === null || passed === undefined) {
      return '<div class="sic-kv"><span>' + EM + '</span><strong>' +
             _esc(unknown || 'Not checked') + '</strong></div>';
    }
    return '<div class="sic-kv"><span>' + (passed ? '✓' : '⚠') + '</span><strong>' +
           _esc(passed ? yes : no) + '</strong></div>';
  }

  /** The card for ONE function: source contract, serving state, and the
      parity checks between them. */
  function _gcpFunctionCard(d) {
    var cmp = d.compute || {};
    var inv = ((cmp.functions || {}).inventory || {}).value || [];
    var f = inv.filter(function (x) { return x.name === _gcpPick.id; })[0];
    var ct = (((cmp.contracts || {}).inventory || {}).value || [])
      .filter(function (x) { return x.fn === _gcpPick.id; })[0];
    var close = '<button class="sic-x" aria-label="Close" ' +
                'onclick="SokoniIntegrations.gcpPick(null)">✕</button>';
    if (!f) return '';

    var runInv = ((cmp.cloudRun || {}).inventory || {}).value || [];
    var svc = f.service ? runInv.filter(function (x) { return x.name === f.service; })[0] : null;

    return '<div class="sic-card"><div class="sic-group-h">' + _esc(f.name) + close + '</div>' +
      '<div class="sic-kv"><span>State</span><strong>' + _esc(f.state || EM) + '</strong></div>' +
      '<div class="sic-kv"><span>Region</span><strong class="sic-mono">' + _esc(f.region || EM) + '</strong></div>' +
      '<div class="sic-kv"><span>Runtime</span><strong>' + _esc(f.runtime || EM) + '</strong></div>' +
      '<div class="sic-kv"><span>Trigger</span><strong>' + _esc(f.trigger || EM) + '</strong></div>' +
      '<div class="sic-kv"><span>Memory</span><strong>' + _esc(f.memory || EM) + '</strong></div>' +
      '<div class="sic-kv"><span>Timeout</span><strong>' +
        (f.timeout === null || f.timeout === undefined ? EM : _esc(String(f.timeout) + ' s')) + '</strong></div>' +
      '<div class="sic-kv"><span>Service account</span><strong class="sic-mono">' +
        _esc(f.serviceAccount || EM) + '</strong></div>' +

      '<div class="sic-sect-l">Source contract</div>' +
      (ct
        ? '<div class="sic-kv"><span>minInstances</span><strong>' +
            (ct.srcMin === null ? EM + ' <em>unset</em>' : _esc(String(ct.srcMin))) + '</strong></div>' +
          '<div class="sic-kv"><span>maxInstances</span><strong>' +
            (ct.srcMax === null ? EM + ' <em>unset</em>' : _esc(String(ct.srcMax))) + '</strong></div>'
        : '<p class="sic-note">No source contract was supplied for this function, so there is ' +
          'nothing to compare. That is <strong>not</strong> the same as being in parity.</p>') +

      '<div class="sic-sect-l">Serving state</div>' +
      '<div class="sic-kv"><span>minScale</span><strong>' +
        (f.minInstances === null || f.minInstances === undefined
          ? EM + ' <em>unset</em>' : _esc(String(f.minInstances))) + '</strong></div>' +
      '<div class="sic-kv"><span>maxScale</span><strong>' +
        (f.maxInstances === null || f.maxInstances === undefined
          ? EM + ' <em>unset</em>' : _esc(String(f.maxInstances))) + '</strong></div>' +
      '<div class="sic-kv"><span>Revision</span><strong class="sic-mono">' +
        _esc(f.revision || EM) + '</strong></div>' +
      '<div class="sic-kv"><span>Cloud Run service</span><strong class="sic-mono">' +
        (f.service ? _pickCell('service', f.service, f.service) : EM) + '</strong></div>' +
      (svc
        ? '<div class="sic-kv"><span>Traffic</span><strong>' +
            ((svc.traffic || []).map(function (t) {
              return _esc(String(t.revision)) + ' ' + _esc(String(t.percent)) + '%'; }).join(', ') || EM) +
          '</strong></div>' +
          '<div class="sic-kv"><span>Ready</span><strong>' + (svc.ready ? 'TRUE' : 'FALSE') + '</strong></div>' +
          '<div class="sic-kv"><span>Image</span><strong class="sic-mono">' + _esc(svc.image || EM) + '</strong></div>'
        : '<p class="sic-note">The Cloud Run service behind this function was not in the ' +
          'inventory, so traffic, readiness and the image digest are ' + EM + '.</p>') +

      '<div class="sic-sect-l">Contract</div>' +
      (ct
        ? _check(ct.maxParity, 'source and serving maximum agree',
                 'source and serving maximum DISAGREE') +
          _check(ct.minPinned, 'minimum is pinned', 'minimum is NOT pinned') +
          _check(!ct.gcfDisagrees, 'the GCF layer agrees with serving',
                 'the GCF layer DISAGREES with serving — an observability discrepancy, not evidence') +
          (ct.verdict ? '<p class="sic-note"><strong>' + _esc(ct.verdict) + '</strong> ' +
                        _esc(ct.detail || '') + '</p>' : '')
        : _check(null, '', '', 'No contract supplied — nothing was checked')) +

      '<div class="sic-sect-l">Observed</div>' +
      '<p class="sic-note">A 30-day instance peak for THIS function needs a per-function metric ' +
      'query, which this reader does not make. It is ' + EM + ' rather than a number borrowed from ' +
      'the estate-wide peak, which would be a different function’s figure wearing this ' +
      'one’s name.</p></div>';
  }

  /** The card for ONE service account. */
  function _gcpServiceAccountCard(d) {
    var sec = d.security || {};
    var rows = ((sec.serviceAccounts || {}).inventory || {}).value || [];
    var a = rows.filter(function (x) { return x.email === _gcpPick.id; })[0];
    var close = '<button class="sic-x" aria-label="Close" ' +
                'onclick="SokoniIntegrations.gcpPick(null)">✕</button>';
    if (!a) return '';

    var cmp = d.compute || {};
    var runInv = ((cmp.cloudRun || {}).inventory || {}).value || [];
    var fnInv  = ((cmp.functions || {}).inventory || {}).value || [];
    var usedByRun = runInv.filter(function (s) { return s.serviceAccount === a.email; });
    var usedByFn  = fnInv.filter(function (f) { return f.serviceAccount === a.email; });

    return '<div class="sic-card"><div class="sic-group-h sic-mono">' + _esc(a.email) + close + '</div>' +
      '<div class="sic-sect-l">Roles held</div>' +
      ((a.roles || []).length
        ? (a.roles || []).map(function (r) {
            return '<span class="sic-chip sic-mono">' + _esc(r) + '</span>'; }).join('')
        : '<p class="sic-note">No project-level role binding. That does not mean no access — it ' +
          'may hold a resource-level binding this reader does not enumerate.</p>') +

      '<div class="sic-sect-l">Used by</div>' +
      (a.usageKnown
        ? ((usedByRun.length || usedByFn.length)
            ? usedByRun.map(function (s) {
                return '<span class="sic-chip sic-mono">run: ' + _esc(s.name) + '</span>'; }).join('') +
              usedByFn.map(function (f) {
                return '<span class="sic-chip sic-mono">fn: ' + _esc(f.name) + '</span>'; }).join('')
            : '<p class="sic-note"><strong>Nothing in the inventory runs as this identity.</strong> ' +
              'It holds access with no workload behind it. It may still be used by something ' +
              'outside Cloud Run and Functions, which this reader does not see.</p>')
        : '<p class="sic-note">' + EM + ' A workload inventory could not be read, so what runs as ' +
          'this identity is <strong>unknown</strong>. That is not the same as nothing.</p>') +

      '<div class="sic-sect-l">Not read</div>' +
      '<p class="sic-note">Which secrets this identity can access, and when it was last used, are ' +
      EM + '. Both need queries this reader does not make — a per-secret IAM read and an access-log ' +
      'query. No risk indicator is derived: the bindings above are the evidence.</p></div>';
  }

  function _gcpPickCard(d) {
    if (!_gcpPick) return '';
    if (_gcpPick.kind === 'function') return _gcpFunctionCard(d);
    if (_gcpPick.kind === 'sa')       return _gcpServiceAccountCard(d);
    return '';
  }

  /** A button that opens a drill-down. Distinct from _metric's figure link,
      which opens a CATALOGUE entry. */
  function _drillBtn(id, label) {
    return '<button class="sic-chip sic-link" onclick="SokoniIntegrations.gcpDrill(\'' +
           _esc(id) + '\')" aria-pressed="' + (_gcpDrill === id) + '">' + _esc(label) + '</button>';
  }

  /* ── THE DRILL-DOWNS ─────────────────────────────────────────────────
     Each is an evidence table over a real inventory. None computes a score: a
     score is an opinion wearing the authority of a measurement. Where a
     judgement would be useful, the CONDITION is shown instead and the operator
     draws the conclusion. */
  function _gcpDrillPanel(d) {
    if (!_gcpDrill) return '';
    var cmp = d.compute || {}, sec = d.security || {}, data = d.data || {};
    var close = '<button class="sic-x" aria-label="Close" ' +
                'onclick="SokoniIntegrations.gcpDrill(null)">✕</button>';

    if (_gcpDrill === 'functions') {
      var f = cmp.functions || {};
      return '<div class="sic-card"><div class="sic-group-h">Cloud Functions' + close + '</div>' +
        _metric('Scaling contract across the estate', f.scaling) +
        _metric('Minimum instances pinned', f.pinnedMinimum) +
        '<p class="sic-note">A function with no explicit maximum is <strong>unbounded</strong>. A ' +
        'pinned minimum costs money while idle. Both are facts; neither is scored here.</p>' +
        '<p class="sic-note"><strong>Source contract is not in this table.</strong> What a function ' +
        'DECLARES in the repository and what it is SERVING are different things, and only the ' +
        'serving side is an API fact. The column is null rather than absent so the gap is visible.</p>' +
        _invTable(f.inventory, [
          ['Function', function (r) { return { html: _pickCell('function', r.name, r.name) }; }],
          ['Region', function (r) { return r.region; }],
          ['State', function (r) { return r.state; }],
          ['Runtime', function (r) { return r.runtime; }],
          ['Cloud Run service', function (r) { return r.service; }],
          ['Revision', function (r) { return r.revision; }],
          ['Memory', function (r) { return r.memory; }],
          ['Timeout', function (r) { return r.timeout; }],
          ['min', function (r) { return r.minInstances; }],
          ['max', function (r) { return r.maxInstances; }],
          ['Service account', function (r) { return r.serviceAccount; }],
        ]) + '</div>';
    }

    if (_gcpDrill === 'run') {
      var s = cmp.cloudRun || {};
      return '<div class="sic-card"><div class="sic-group-h">Cloud Run' + close + '</div>' +
        '<p class="sic-note">A Gen2 Cloud Function <em>is</em> a Cloud Run service. The chain is ' +
        '<span class="sic-mono">function → service → revision → image digest → registry</span>, ' +
        'and every link in it is a column below.</p>' +
        _invTable(s.inventory, [
          ['Service', function (r) { return r.name; }],
          ['Region', function (r) { return r.region; }],
          ['Ready', function (r) { return r.ready ? 'TRUE' : 'FALSE'; }],
          ['Latest ready', function (r) { return r.latestReadyRevision; }],
          ['Latest created', function (r) { return r.latestCreatedRevision; }],
          ['Parity', function (r) { return r.revisionParity ? 'ok' : 'MISMATCH'; }],
          ['min', function (r) { return r.minScale; }],
          ['max', function (r) { return r.maxScale; }],
          ['Conc.', function (r) { return r.concurrency; }],
          ['CPU', function (r) { return r.cpu; }],
          ['Memory', function (r) { return r.memory; }],
          ['Timeout', function (r) { return r.timeout; }],
          ['Image', function (r) { return r.image; }],
          ['Service account', function (r) { return r.serviceAccount; }],
        ]) +
        '<p class="sic-note"><strong>max shown as ' + EM + ' means no explicit limit</strong> — ' +
        'unbounded, not zero. A blank maximum and a maximum of zero are different contracts.</p>' +
        '</div>';
    }

    if (_gcpDrill === 'artifacts') {
      var ar = cmp.artifactRegistry || {}, im = cmp.images || {}, pv = cmp.provenance || {};
      return '<div class="sic-card"><div class="sic-group-h">Artifact Registry' + close + '</div>' +
        '<div class="sic-sect-l">Repositories and their cleanup policies</div>' +
        _invTable(ar.inventory, [
          ['Repository', function (r) { return r.name; }],
          ['Location', function (r) { return r.location; }],
          ['Format', function (r) { return r.format; }],
          ['Enforcing', function (r) { return r.enforcing ? 'YES' : 'dry-run'; }],
          ['Policies', function (r) {
            return (r.policies || []).map(function (p) {
              return p.id + '=' + (p.action || '?') +
                (p.olderThan ? '/' + p.olderThan : '') +
                (p.tagState ? '/' + p.tagState : '') +
                (p.keepCount ? '/keep' + p.keepCount : '');
            }).join('  ');
          }],
        ]) +
        _metric('Repositories with DELETE and no KEEP', ar.reposWithDeleteOnly) +
        '<p class="sic-note">A policy is <strong>enforcing unless its dry-run flag is set</strong>, ' +
        'and that flag disables deletion rather than previewing it. A DELETE policy with no KEEP ' +
        'beside it is reference-blind: it is capable of removing an image a live revision still ' +
        'depends on.</p>' +

        '<div class="sic-sect-l">Provenance — revision → digest → registry</div>' +
        _metric('Services pinned by digest', pv.servicesPinnedByDigest) +
        _metric('Services pinned by tag', pv.servicesPinnedByTag) +
        _metric('Serving image MISSING from the registry', pv.imageMissingFromRegistry) +
        _invTable(pv.missingInventory, [
          ['Service', function (r) { return r.service; }],
          ['Region', function (r) { return r.region; }],
          ['Digest', function (r) { return r.digest; }],
        ]) +
        '<p class="sic-note">A serving image whose digest is not in the registry is exactly the ' +
        'condition that leaves a service unable to create a new revision from its existing spec. ' +
        'The old revision keeps serving, so nothing looks wrong until a deploy is attempted.</p>' +

        '<div class="sic-sect-l">Images</div>' +
        _metric('Images', im.images) +
        _invTable(im.inventory, [
          ['Image', function (r) { return r.name; }],
          ['Repository', function (r) { return r.repo; }],
          ['Digest', function (r) { return r.digest; }],
          ['Tags', function (r) { return (r.tags || []).join(' '); }],
          ['Uploaded', function (r) { return r.uploadTime; }],
        ]) + '</div>';
    }

    if (_gcpDrill === 'admins') {
      var iam = sec.iam || {};
      return '<div class="sic-card"><div class="sic-group-h">Administrators' + close + '</div>' +
        '<p class="sic-note">Who can actually change this project, as the <strong>real IAM ' +
        'bindings</strong>. No risk score is computed — a score is an opinion wearing the ' +
        'authority of a measurement. The bindings are the evidence.</p>' +
        '<div class="sic-sect-l">Privileged roles</div>' +
        _invTable(iam.adminBindings, [
          ['Role', function (r) { return r.role; }],
          ['Principals', function (r) { return r.memberCount; }],
          ['Members', function (r) { return (r.members || []).join('  '); }],
          ['Conditional', function (r) { return r.conditional ? 'yes' : 'no'; }],
        ]) +
        '<div class="sic-sect-l">Human principals</div>' +
        _metric('People with a binding', iam.humanPrincipals) +
        '<div class="sic-sect-l">Groups</div>' +
        _metric('Groups with a binding', iam.groupPrincipals) +
        '<p class="sic-note">Human and machine principals are separated because they have ' +
        'different revocation paths. A person who leaves is an offboarding task; a service ' +
        'account is not.</p>' +
        '<div class="sic-sect-l">Every binding</div>' +
        _invTable(iam.bindingInventory, [
          ['Role', function (r) { return r.role; }],
          ['Principals', function (r) { return r.memberCount; }],
          ['Members', function (r) { return (r.members || []).join('  '); }],
        ]) + '</div>';
    }

    if (_gcpDrill === 'audit') {
      var iam2 = sec.iam || {}, act = d.activity || {};
      return '<div class="sic-card"><div class="sic-group-h">Audit logging' + close + '</div>' +
        _metric('Services with an audit config', iam2.auditServices) +
        _metric('Log types enabled', iam2.auditLogTypes) +
        _invTable(iam2.auditCoverage, [
          ['Service', function (r) { return r.service; }],
          ['Log types', function (r) { return (r.logTypes || []).join(' '); }],
          ['Exempted members', function (r) { return r.exemptedMembers; }],
        ]) +
        '<p class="sic-note">A service <strong>absent from this table has Admin Activity logging ' +
        'only</strong>. That is the default, it cannot be switched off, and it does NOT mean Data ' +
        'Access is being recorded. An exempted member is excluded from logging for that service.</p>' +

        '<div class="sic-sect-l">Recent admin activity</div>' +
        _metric('Events read', act.events) +
        _metric('Of which failed', act.failures) +
        _metric('Most recent event', act.lastEventAt) +
        _invTable(act.timeline, [
          ['When', function (r) { return r.at; }],
          ['Service', function (r) { return r.service; }],
          ['Method', function (r) { return r.method; }],
          ['Resource', function (r) { return r.resource; }],
          ['Outcome', function (r) { return r.failed ? 'FAILED' : 'ok'; }],
        ]) +
        '<p class="sic-note">Admin Activity only. Data Access entries can carry request payloads, ' +
        'so this console does not read them — a timeline is not worth leaking a request body for.</p>' +
        '</div>';
    }

    if (_gcpDrill === 'contracts') {
      var ct = cmp.contracts || {};
      return '<div class="sic-card"><div class="sic-group-h">Scaling contract' + close + '</div>' +
        '<p class="sic-note">What a function <strong>declares in the repository</strong> against ' +
        'what is <strong>actually serving</strong>. The gap between those two is the defect that ' +
        'removed a production ceiling during a rebuild.</p>' +
        _metric('Adjudicated', ct.adjudicated) +
        _metric('No source contract supplied', ct.withoutContract) +
        _metric('Source and serving maximum DISAGREE', ct.maxMismatch) +
        _metric('Serving minimum not pinned', ct.minUnpinned) +
        _metric('GCF layer disagrees with serving', ct.gcfDiscrepancy) +
        _metric('Contract captured', ct.capturedAt) +

        '<p class="sic-note"><strong>A function with no supplied contract is not "in parity."</strong> ' +
        'Nothing was compared for it, which is why it is counted separately above rather than ' +
        'folded into the agreeing ones.</p>' +

        _invTable(ct.inventory, [
          ['Function', function (r) { return r.fn; }],
          ['Region', function (r) { return r.region; }],
          ['src min', function (r) { return r.srcMin; }],
          ['src max', function (r) { return r.srcMax; }],
          ['serving min', function (r) { return r.runMin; }],
          ['serving max', function (r) { return r.runMax; }],
          ['GCF min', function (r) { return r.gcfMin; }],
          ['max parity', function (r) { return r.maxParity ? 'ok' : 'DISAGREE'; }],
          ['min pinned', function (r) { return r.minPinned ? 'yes' : 'NOT PINNED'; }],
          ['Verdict', function (r) { return r.verdict; }],
        ]) +

        ((ct.note && ct.note.state === 'observed')
          ? '<div class="sic-sect-l">Why parity is measured against the SERVING revision</div>' +
            '<p class="sic-note">' + _esc(ct.note.value) + '</p>'
          : '') +
        '<p class="sic-note">A blank minimum or maximum is <strong>unset</strong> — no limit — ' +
        'not zero. The two are different contracts and are rendered differently.</p></div>';
    }

    if (_gcpDrill === 'secrets') {
      var sm = sec.secrets || {};
      return '<div class="sic-card"><div class="sic-group-h">Secret Manager' + close + '</div>' +
        _metric('Secrets', sm.secrets, 'secret-manager') +
        _metric('With a rotation policy', sm.withRotation) +
        _metric('With an expiry', sm.withExpiry) +
        '<div class="sic-sect-l">Secret names</div>' +
        _metric('Names', sm.names) +
        '<p class="sic-note"><strong>Names only, and that is a property of the API used.</strong> ' +
        'This reader calls <span class="sic-mono">secrets.list</span>, which returns metadata and ' +
        '<em>cannot</em> return a payload. The access API that can is never called, and adding it ' +
        'would change what a compromise of this console is worth.</p>' +
        '<div class="sic-sect-l">Declared vs provisioned</div>' +
        _metric('Secret names the rails declare', (sec.secretCoverage || {}).declared) +
        _metric('Secrets that exist', (sec.secretCoverage || {}).provisioned) +
        _metric('DECLARED but MISSING', (sec.secretCoverage || {}).missing) +
        _invTable((sec.secretCoverage || {}).missingNames, [
          ['Missing secret', function (r) { return r.secret; }],
        ]) +
        '<p class="sic-note">A declared secret that does not exist is a rail that will <strong>fail ' +
        'when it runs</strong>. This is the one question the Credentials tab can only ask — it ' +
        'knows what is declared, not what is provisioned.</p>' +
        _metric('Present but not declared', (sec.secretCoverage || {}).unmatched) +
        _invTable((sec.secretCoverage || {}).unmatchedNames, [
          ['Unmatched secret', function (r) { return r.secret; }],
        ]) +
        '<p class="sic-note">An unmatched secret is <strong>not a fault</strong> and not something ' +
        'to delete. It may belong to a system outside this registry. It is listed so the two sides ' +
        'can be reconciled deliberately.</p>' +
        '<div class="sic-sect-l">Not read</div>' +
        '<p class="sic-note">Version counts, expired versions, last rotation time, per-secret ' +
        'consumers and access failures are ' + EM + ' — each needs a per-secret call this reader ' +
        'does not make, and an access-log query it deliberately does not make. They are not ' +
        'zero.</p></div>';
    }

    if (_gcpDrill === 'databases') {
      var fsd = (data.firestore || {});
      var dbs2 = fsd.databases || {};
      return '<div class="sic-card"><div class="sic-group-h">Firestore databases' + close + '</div>' +
        _metric('Composite-index quota (live)', fsd.quota) +
        '<p class="sic-note">Two databases with <strong>separate rules and separate indexes</strong>. ' +
        'A deploy naming one does not carry the other.</p>' +
        Object.keys(dbs2).map(function (id) { return _gcpDatabase(id, dbs2[id]); }).join('') +
        '<div class="sic-sect-l">Not read</div>' +
        '<p class="sic-note">Document counts, the deployed ruleset and recent query or index ' +
        'failures are ' + EM + '. Document counts need an aggregation per collection, the ruleset ' +
        'needs the Rules API, and query failures need a log query — none of which this reader ' +
        'makes. Each is <strong>not measured</strong>, not zero.</p></div>';
    }

    if (_gcpDrill === 'telemetry') {
      var ob = d.observability || {};
      var t = ob.telemetry || {}, incs = ob.incidents || {};
      return '<div class="sic-card"><div class="sic-group-h">Cloud Monitoring' + close + '</div>' +
        '<p class="sic-note">Every figure below is a real metric series over the last ' +
        _esc(String(t.windowHours || '?')) + ' hours. A number with no window attached to it is ' +
        'not a measurement, so the window is part of the reading.</p>' +
        '<div class="sic-sect-l">Cloud Run</div>' +
        _metric('Requests', t.runRequests) +
        _metric('5xx responses', t.run5xx) +
        _metric('Peak concurrent instances', t.runInstancePeak) +
        '<div class="sic-sect-l">Cloud Functions</div>' +
        _metric('Executions', t.fnExecutions) +
        _metric('Non-ok executions', t.fnErrors) +
        '<div class="sic-sect-l">Firestore</div>' +
        _metric('Document reads', t.firestoreReads) +
        _metric('Document writes', t.firestoreWrites) +
        _metric('Document deletes', t.firestoreDeletes) +
        '<div class="sic-sect-l">Alerting</div>' +
        _metric('Alert policies', (ob.monitoring || {}).alertPolicies) +
        _metric('Enabled', (ob.monitoring || {}).enabled) +
        _metric('With a notification channel', (ob.monitoring || {}).withNotification) +
        _metric('Open incidents', incs.openIncidents) +
        '<p class="sic-note">A metric series with no points is a <strong>measured zero over that ' +
        'window</strong> — genuinely quiet. That is a different fact from a failed read, and the ' +
        'two are badged differently above.</p></div>';
    }

    if (_gcpDrill === 'cost') {
      var c2 = d.cost || {}, bill2 = (d.observability || {}).billing || {};
      var bud = (d.observability || {}).budgets || {};
      return '<div class="sic-card"><div class="sic-group-h">Billing &amp; cost' + close + '</div>' +
        _metric('Billing enabled', bill2.billingEnabled) +
        _metric('Billing account', bill2.billingAccount) +
        _metric('Budgets', bud.budgets) +
        _metric('Budgets with a threshold rule', bud.withThresholds) +
        _metric('Budget names', bud.budgetNames) +

        '<div class="sic-sect-l">Cost conditions</div>' +
        '<p class="sic-note">These are <strong>conditions, not verdicts</strong>. A pinned minimum ' +
        'bills while idle; an unbounded maximum has no ceiling. Whether either is correct depends ' +
        'on the service, and this reader does not know which — so it shows the condition and the ' +
        'services it applies to, and stops there.</p>' +
        _metric('Services with a pinned minimum', c2.pinnedInstances) +
        _invTable(c2.pinnedInventory, [
          ['Service', function (r) { return r.service; }],
          ['Region', function (r) { return r.region; }],
          ['min', function (r) { return r.minScale; }],
          ['max', function (r) { return r.maxScale; }],
        ]) +
        _metric('Services with NO maximum', c2.unboundedServices) +
        _invTable(c2.unboundedInventory, [
          ['Service', function (r) { return r.service; }],
          ['Region', function (r) { return r.region; }],
        ]) +
        _metric('Services with a very high maximum', c2.highMaxScale) +
        _invTable(c2.highMaxInventory, [
          ['Service', function (r) { return r.service; }],
          ['Region', function (r) { return r.region; }],
          ['max', function (r) { return r.maxScale; }],
        ]) +
        _metric('Services with no observed traffic', c2.servicesWithNoObservedTraffic) +
        _metric('Cost breakdown by service', c2.costBreakdown) +
        '<p class="sic-note">The last two are <strong>not measured</strong>, not zero. A cost ' +
        'breakdown needs the billing export dataset and per-service traffic needs a per-service ' +
        'metric query; this reader makes neither.</p></div>';
    }

    if (_gcpDrill === 'serviceaccounts') {
      var sa = sec.serviceAccounts || {};
      return '<div class="sic-card"><div class="sic-group-h">Service accounts' + close + '</div>' +
        '<p class="sic-note">A join across three readings: the IAM policy says which identities ' +
        '<em>hold roles</em>, and the Cloud Run and Functions inventories say which workloads ' +
        '<em>run as</em> them. Those are different questions, and only the join answers the ' +
        'second.</p>' +
        _metric('Service accounts seen', sa.total) +
        _metric('Holding roles but running nothing', sa.withoutWorkload) +
        _invTable(sa.inventory, [
          ['Service account', function (r) { return { html: _pickCell('sa', r.email, r.email) }; }],
          ['Roles', function (r) { return r.roleCount; }],
          ['Cloud Run services', function (r) { return r.runServices; }],
          ['Functions', function (r) { return r.functions; }],
          ['Runs nothing', function (r) {
            return r.usageKnown ? (r.unusedByWorkloads ? 'YES' : 'no') : '—'; }],
          ['Granted roles', function (r) { return (r.roles || []).join('  '); }],
        ]) +
        '<p class="sic-note">An identity holding roles that nothing runs as is an account with ' +
        'access and no owner. It is shown as a <strong>condition</strong>, not scored — it may be ' +
        'used by something outside Cloud Run and Functions, which this reader does not see. Where ' +
        'a workload inventory could not be read, the column is ' + EM + ' rather than "no", ' +
        'because "nothing runs as this" would then be a claim about a failed read.</p></div>';
    }

    if (_gcpDrill === 'appcheck') {
      var ac = sec.appCheck || {};
      return '<div class="sic-card"><div class="sic-group-h">App Check' + close + '</div>' +
        _metric('Services configured', ac.services) +
        _metric('Enforced', ac.enforced) +
        _metric('Not enforced', ac.unenforced) +
        _invTable(ac.inventory, [
          ['Service', function (r) { return r.service; }],
          ['Enforcement', function (r) { return r.mode; }],
        ]) +
        '<p class="sic-note">A service that is not enforcing accepts requests without attestation. ' +
        'That is not automatically a fault — some endpoints are public or webhook receivers by ' +
        'design. Audit the endpoint, not the count.</p></div>';
    }

    if (_gcpDrill === 'storage') {
      var st = data.storage || {};
      return '<div class="sic-card"><div class="sic-group-h">Cloud Storage' + close + '</div>' +
        _metric('Buckets', st.buckets, 'cloud-storage') +
        _metric('Locations', st.locations) +
        _metric('With public access prevention enforced', st.publicAccessPrevention) +
        _metric('With uniform bucket-level access', st.uniformAccess) +
        _metric('Bucket names', st.names) +
        '<p class="sic-note">Bucket-level configuration only. Object counts and stored bytes are ' +
        'not read — that is a usage query this reader does not make, so it is ' + EM +
        ' rather than a guess.</p></div>';
    }

    if (_gcpDrill === 'apis') {
      var ap = d.apis || {};
      return '<div class="sic-card"><div class="sic-group-h">Enabled APIs' + close + '</div>' +
        _metric('Enabled services', ap.enabled) +
        _metric('Names', ap.names) +
        '<p class="sic-note">Diagnostic, not decorative: an API that is <strong>off</strong> ' +
        'explains a whole control plane reading as unreadable above.</p></div>';
    }

    return '';
  }

  /* ── THE INFRASTRUCTURE RELATIONSHIP GRAPH ───────────────────────────
     Drawn from OBSERVATIONS, not from a hand-written picture. Each node
     carries the figure that was actually read, and a node whose reading failed
     is drawn muted with an em dash rather than omitted — an absent box would
     read as "no such thing", which is a different claim from "not measured".

     Clicking a node opens the evidence panel behind it. */
  function _gcpGraph(d) {
    var cmp = d.compute || {}, data = d.data || {}, sec = d.security || {};
    var fsdb = (data.firestore || {}).databases || {};

    function node(x, y, w, label, obs, drill) {
      var v = _obsValue(obs);
      var dead = (v === EM);
      return '<g class="sg-n' + (dead ? ' dead' : '') + '"' +
        (drill ? ' role="button" tabindex="0" style="cursor:pointer" ' +
                 'onclick="SokoniIntegrations.gcpDrill(\'' + _esc(drill) + '\')"' : '') + '>' +
        '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="34" rx="6"></rect>' +
        '<text x="' + (x + 10) + '" y="' + (y + 14) + '">' + _esc(label) + '</text>' +
        '<text x="' + (x + 10) + '" y="' + (y + 27) + '" class="sg-v">' + v + '</text>' +
        '</g>';
    }
    function edge(x1, y1, x2, y2) {
      return '<path class="sg-e" d="M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + ((y1 + y2) / 2) +
             ',' + x2 + ' ' + ((y1 + y2) / 2) + ',' + x2 + ' ' + y2 + '"/>';
    }

    var dbCount = { value: Object.keys(fsdb).length, state: Object.keys(fsdb).length ? 'observed' : 'not-attempted' };

    return '<div class="sic-card"><div class="sic-group-h">Infrastructure relationships</div>' +
      '<p class="sic-note">Drawn from what was <strong>read</strong>. A node whose reading failed ' +
      'is dimmed and shows ' + EM + ' — it is not removed, because an absent box would say "no ' +
      'such thing" when the truth is "not measured". Select a node to open its evidence.</p>' +
      '<div class="sic-scroll"><svg class="sg" viewBox="0 0 760 330" width="760" height="330" ' +
      'role="img" aria-label="Infrastructure relationship graph">' +
      edge(120, 54, 120, 92) + edge(120, 54, 400, 92) +
      edge(120, 126, 120, 164) +
      edge(400, 126, 400, 164) + edge(400, 126, 620, 164) +
      edge(400, 198, 400, 236) +
      edge(400, 270, 620, 236) +
      node(40, 20, 160, 'SOKONI', { value: d.project, state: d.project ? 'observed' : 'not-attempted' }) +
      node(40, 92, 160, 'Firestore databases', dbCount, 'storage') +
      node(40, 164, 160, 'Cloud Storage buckets', (data.storage || {}).buckets, 'storage') +
      node(320, 92, 160, 'Cloud Functions', (cmp.functions || {}).total, 'functions') +
      node(320, 164, 160, 'Cloud Run services', (cmp.cloudRun || {}).services, 'run') +
      node(320, 236, 160, 'Image digests', (cmp.images || {}).images, 'artifacts') +
      node(560, 164, 160, 'Artifact repositories', (cmp.artifactRegistry || {}).repositories, 'artifacts') +
      node(560, 236, 160, 'Missing from registry',
           (cmp.provenance || {}).imageMissingFromRegistry, 'artifacts') +
      node(560, 20, 160, 'Administrators', (sec.iam || {}).principals, 'admins') +
      node(320, 20, 160, 'Service accounts', (sec.serviceAccounts || {}).total, 'serviceaccounts') +
      '</svg></div>' +
      '<p class="sic-note">The chain that matters runs left to right along the bottom: a function ' +
      'runs as a Cloud Run service, a service pins an image by digest, and that digest either is ' +
      'or is not still in the registry. The last box is the one to watch.</p></div>';
  }

  /** The evidence timeline, as its own panel. */
  function _gcpActivity(d) {
    var act = d.activity || {};
    return '<div class="sic-card"><div class="sic-group-h">Recent activity</div>' +
      _metric('Admin Activity events read', act.events) +
      _metric('Of which failed', act.failures) +
      _metric('Most recent event', act.lastEventAt) +
      _invTable(act.timeline, [
        ['When', function (r) { return r.at; }],
        ['Service', function (r) { return r.service; }],
        ['Method', function (r) { return r.method; }],
        ['Resource', function (r) { return r.resource; }],
        ['Outcome', function (r) { return r.failed ? 'FAILED' : 'ok'; }],
      ]) +
      '<p class="sic-note"><strong>Admin Activity only.</strong> Data Access entries can carry ' +
      'request payloads, so this console does not read them — a timeline is not worth leaking a ' +
      'request body for. A failed entry is an operation that was ATTEMPTED and refused, which is ' +
      'usually the more interesting half.</p></div>';
  }

  function _gcpPanel() {
    if (_gcp.state === 'idle' || _gcp.state === 'running') {
      return '<div class="sic-card"><div class="sic-group-h">Google Cloud</div>' +
        '<p class="sic-note">' + (_gcp.state === 'running'
          ? 'Reading the infrastructure control plane…'
          : 'Not measured yet.') + '</p></div>';
    }

    if (_gcp.state === 'failed') {
      return '<div class="sic-card"><div class="sic-group-h">Google Cloud</div>' +
        '<div class="sic-kv"><span>Control plane</span><strong>' +
        '<span class="sic-badge unknown"><span class="sic-dot"></span>Not measured</span>' +
        '</strong></div>' +
        '<p class="sic-note"><strong>No infrastructure figure is shown, because none was ' +
        'obtained.</strong> ' + _esc(_gcp.error) + '</p>' +
        '<p class="sic-note">This is the expected state until the GCP evidence reader is ' +
        'deployed. Database regions, index state, READY counts and collection counts are ' +
        'Admin-API facts: no browser can obtain them, so they are shown as ' + EM +
        ' rather than guessed. Every Google Cloud service remains individually addressable ' +
        'in the Catalogue tab.</p>' +
        '<div class="sic-sect-l">Addressable now</div>' +
        ['firestore', 'firestore-sokoni-ops', 'firestore-indexes', 'cloud-run',
         'cloud-functions', 'artifact-registry', 'cloud-storage', 'secret-manager',
         'cloud-monitoring', 'cloud-scheduler', 'app-check'].map(function (id) {
          var e = _cat() && _cat().lookup ? _cat().lookup(id) : null;
          if (!e) return '';
          return '<button class="sic-chip sic-link" onclick="SokoniIntegrations.selectCatalogue(\'' +
                 _esc(id) + '\')">' + _esc(e.name) + '</button>';
        }).join('') +
        '</div>';
    }

    var d   = _gcp.data || {};
    var fs_ = (d.data && d.data.firestore) || {};
    var dbs = fs_.databases || d.databases || {};
    var cmp = d.compute || {};
    var obs = d.observability || {};
    var sec = d.security || {};
    var run = cmp.cloudRun || {}, fns = cmp.functions || {}, ar = cmp.artifactRegistry || {};
    var iam = sec.iam || {}, secrets = sec.secrets || {};
    var mon = obs.monitoring || {}, bill = obs.billing || {};
    var pi  = d.projectInfo || {};

    /* ── Header. The estate's identity and how much of it was readable. ── */
    var head = '<div class="sic-card"><div class="sic-group-h">Google Cloud Platform</div>' +
      '<div class="sic-kv"><span>Project</span><strong class="sic-mono">' +
      _esc(d.project || EM) + '</strong></div>' +
      _metric('Project number', pi.projectNumber) +
      _metric('Project state', pi.state) +
      _metric('Region coverage', d.regions) +
      '<div class="sic-kv"><span>Read at</span><strong>' +
      (d.generatedAt ? _esc(_stamp(Date.parse(d.generatedAt))) : EM) + '</strong></div>' +
      _metric('Control planes read', d.domainsRead) +
      _metric('Control planes unreadable', d.domainsFailed) +
      _metric('Enabled APIs', (d.apis || {}).enabled) +
      _metric('Last event observed', (d.activity || {}).lastEventAt) +
      _metric('Recent deployments', (d.activity || {}).deployments) +
      _metric('Recent failed operations', (d.activity || {}).failures) +
      '<div class="sic-sect-l">Open</div>' + _drillBtn('apis', 'Enabled APIs') +
      ((d.domainsFailed && d.domainsFailed.value > 0)
        ? '<p class="sic-note"><strong>Part of this cockpit is dark.</strong> A control plane that ' +
          'could not be read shows an em dash and names its error. That is an instrument being ' +
          'out — it is NOT a finding that the resource is absent or healthy.</p>' : '') +
      '</div>';

    /* ── COMPUTE ───────────────────────────────────────────────────── */
    var compute = _gcpSection('Compute',
      '<div class="sic-sect-l">Cloud Functions</div>' +
      _metric('Deployed', fns.total, 'cloud-functions') +
      _metric('Active', fns.active) +
      _metric('Failed', fns.failed) +
      _metric('Deploying', fns.deploying) +
      _metric('Runtimes', fns.runtimes) +

      '<div class="sic-sect-l">Cloud Run</div>' +
      _metric('Services', run.services, 'cloud-run') +
      _metric('Ready', run.ready) +
      /* The failure shape this platform has actually hit. */
      _metric('Created revision not yet ready', run.revisionMismatch) +
      _metric('No explicit max-instance limit', run.unboundedScaling) +
      _metric('Minimum instances pinned', run.pinnedMinimum) +
      ((run.revisionMismatch && run.revisionMismatch.value > 0)
        ? '<p class="sic-note">A service whose latest CREATED revision is not its latest READY ' +
          'one has a revision that failed to come up. The old revision keeps serving, so this is ' +
          'silent unless something looks.</p>' : '') +

      '<div class="sic-sect-l">Artifact Registry</div>' +
      _metric('Repositories', ar.repositories, 'artifact-registry') +
      _metric('Cleanup policies', ar.cleanupPolicies) +
      _metric('Repositories enforcing a policy', ar.enforcingRepos) +
      '<p class="sic-note">A cleanup policy is <strong>enforcing</strong> unless its dry-run flag ' +
      'is set — and that flag disables deletion, it does not preview it. A reference-blind DELETE ' +
      'policy is capable of removing an image a live revision still depends on.</p>' +
      '<div class="sic-sect-l">Scaling contract</div>' +
      _metric('Source and serving maximum disagree', (cmp.contracts || {}).maxMismatch) +
      _metric('Serving minimum not pinned', (cmp.contracts || {}).minUnpinned) +
      _metric('No source contract supplied', (cmp.contracts || {}).withoutContract) +
      '<div class="sic-sect-l">Open</div>' +
      _drillBtn('functions', 'Functions inventory') +
      _drillBtn('contracts', 'Scaling contract') +
      _drillBtn('run', 'Cloud Run services') +
      _drillBtn('artifacts', 'Artifacts & provenance'));

    /* ── DATA ──────────────────────────────────────────────────────── */
    var data = _gcpSection('Data',
      _metric('Composite-index quota (live)', fs_.quota || d.quota) +
      Object.keys(dbs).map(function (id) { return _gcpDatabase(id, dbs[id]); }).join('') +
      _metric('Storage buckets', (d.data && d.data.storage || {}).buckets, 'cloud-storage') +
      '<div class="sic-sect-l">Open</div>' +
      _drillBtn('databases', 'Databases') +
      _drillBtn('storage', 'Storage'));

    /* ── OBSERVABILITY ─────────────────────────────────────────────── */
    var observ = _gcpSection('Observability',
      _metric('Alert policies', mon.alertPolicies, 'cloud-monitoring') +
      _metric('Enabled', mon.enabled) +
      _metric('With a notification channel', mon.withNotification) +
      ((mon.withNotification && mon.alertPolicies &&
        mon.withNotification.state === 'observed' && mon.alertPolicies.state === 'observed' &&
        mon.withNotification.value < mon.alertPolicies.value)
        ? '<p class="sic-note">An alert policy with no notification channel fires into nothing.</p>' : '') +
      '<div class="sic-sect-l">Telemetry (last 24h)</div>' +
      _metric('Cloud Run requests', (obs.telemetry || {}).runRequests) +
      _metric('Cloud Run 5xx', (obs.telemetry || {}).run5xx) +
      _metric('Function executions', (obs.telemetry || {}).fnExecutions) +
      _metric('Firestore reads', (obs.telemetry || {}).firestoreReads) +
      _metric('Firestore writes', (obs.telemetry || {}).firestoreWrites) +
      _metric('Open incidents', (obs.incidents || {}).openIncidents) +
      '<div class="sic-sect-l">Billing</div>' +
      _metric('Billing enabled', bill.billingEnabled) +
      _metric('Billing account', bill.billingAccount) +
      _metric('Budgets', (obs.budgets || {}).budgets) +
      '<div class="sic-sect-l">Open</div>' +
      _drillBtn('telemetry', 'Monitoring & telemetry') +
      _drillBtn('cost', 'Billing & cost control'));

    /* ── SECURITY ──────────────────────────────────────────────────── */
    var security = _gcpSection('Security',
      '<div class="sic-sect-l">IAM</div>' +
      _metric('Role bindings', iam.bindings) +
      _metric('Distinct principals', iam.principals) +
      _metric('Service accounts', iam.serviceAccounts) +
      _metric('Owners', iam.owners) +
      _metric('Editors', iam.editors) +
      '<p class="sic-note">Counts of actual bindings. No risk score is computed here — a score ' +
      'would be an opinion presented with the authority of a measurement.</p>' +

      '<div class="sic-sect-l">Audit logging</div>' +
      _metric('Services with an audit config', iam.auditServices) +
      _metric('Log types enabled', iam.auditLogTypes) +
      '<p class="sic-note">An absent audit config means <strong>Admin Activity only</strong>. It ' +
      'does not mean everything is logged, and Data Access logging is off unless it appears above.</p>' +

      '<div class="sic-sect-l">Secret Manager</div>' +
      _metric('Secrets', secrets.secrets, 'secret-manager') +
      _metric('With a rotation policy', secrets.withRotation) +
      _metric('With an expiry', secrets.withExpiry) +
      '<p class="sic-note">Secret <strong>names</strong> only. This reader calls the list API, ' +
      'which cannot return a value; the access API that can is never called.</p>' +
      '<div class="sic-sect-l">Open</div>' +
      '<div class="sic-sect-l">Service accounts</div>' +
      _metric('Service accounts seen', (sec.serviceAccounts || {}).total, 'secret-manager') +
      _metric('Holding roles but running nothing', (sec.serviceAccounts || {}).withoutWorkload) +
      '<div class="sic-sect-l">App Check</div>' +
      _metric('Services configured', (sec.appCheck || {}).services, 'app-check') +
      _metric('Enforced', (sec.appCheck || {}).enforced) +
      _metric('Not enforced', (sec.appCheck || {}).unenforced) +
      '<div class="sic-sect-l">Open</div>' +
      _drillBtn('admins', 'Administrators') +
      _drillBtn('serviceaccounts', 'Service accounts') +
      _drillBtn('appcheck', 'App Check') +
      _drillBtn('secrets', 'Secret Manager') +
      _drillBtn('audit', 'Audit logging') +
      /* A MOUNT POINT ONLY. The access-management surface is the one WRITE path
         in this console, and it deliberately lives in a separate module
         (sokoni-gcp-admin.js) so THIS module keeps its certified guarantee of
         containing no write path at all. All that is emitted here is an empty
         element for it to render into. */
      '<div id="sgaRoot"></div>');

    /* The reader states its own boundary last, so an absent panel is never read
       as an absent problem. */
    var boundary = '<div class="sic-card">' +
      '<div class="sic-sect-l">Not covered by this reader</div>' +
      '<p class="sic-note">' + _esc((d.notCovered || []).join(' · ')) +
      '. These are not shown as healthy and are not shown as zero — they are simply not measured. ' +
      'Each remains individually addressable in the Catalogue.</p></div>';

    return head + _gcpPickCard(d) + _gcpDrillPanel(d) + compute + data + observ + security +
           _gcpGraph(d) + _gcpActivity(d) + boundary;
  }

  /** Read the GCP control plane. On demand, exactly like the activity
      analytics: the infrastructure is not polled because a console was opened. */
  function _loadGcp() {
    if (_gcp.state === 'running' || _gcp.state === 'done') return Promise.resolve();
    _gcp.state = 'running';
    _render();

    var call;
    var injected = _opts.getGcpEvidence;
    if (typeof injected === 'function') {
      call = Promise.resolve(injected());
    } else if (typeof firebase !== 'undefined' && firebase.functions) {
      try {
        call = firebase.functions()
          .httpsCallable('adminOsDispatch')({ op: 'adminGetGcpEvidence' })
          .then(function (r) { return r.data; });
      } catch (e) {
        call = Promise.reject(e);
      }
    } else {
      call = Promise.reject(new Error('Firebase Functions is not available on this page.'));
    }

    return call.then(function (data) {
      _gcp = { state: 'done', data: data, error: '' };
      _render();
    }).catch(function (e) {
      _gcp = { state: 'failed', data: null,
               error: (e && e.message) || 'The GCP evidence reader did not answer.' };
      _render();
    });
  }

  /* ── Rendering the observed-activity section ─────────────────────────
     Four states, each visually distinct, none collapsible into another:
       running      a read is in flight
       measured     a read returned; the figure is real and its bound is stated
       unreadable   a read failed; the error is named
       none         the entry declares nothing this can measure

     There is no fifth state in which a number is produced without a read. */
  function _dbVerdict(d) {
    if (!d) return '';
    var meta = {
      reachable:   { cls: 'healthy', label: 'Reachable' },
      denied:      { cls: 'error',   label: 'Permission denied' },
      unreachable: { cls: 'error',   label: 'Unreachable' },
    }[d.state] || { cls: 'unknown', label: 'Not attempted' };

    var note;
    if (d.state === 'reachable') {
      note = 'A bounded read against <span class="sic-mono">' + _esc(d.probe) + '</span> returned' +
             (d.empty ? ' with no documents. An empty result is a SUCCESSFUL read: this database ' +
                        'answers and the rules permit it. It is not evidence that the database is empty — ' +
                        'only that this one collection returned nothing.'
                      : ' with at least one document.') +
             ' Reachable is not the same as in use.';
    } else if (d.state === 'denied') {
      note = 'The database answered and REFUSED the read. That is a rules outcome, not an outage — ' +
             'the database is there. Reported error: ' + _esc(d.error);
    } else if (d.state === 'unreachable') {
      note = 'The read did not complete, so this database’s state is UNKNOWN. This is a failed ' +
             'observation, not a finding that anything is wrong with it. Reported error: ' + _esc(d.error);
    } else {
      note = 'No read was attempted, so nothing is known about this database from this console.';
    }

    return '<div class="sic-sect-l">Database probe</div>' +
      '<div class="sic-kv"><span>Database</span><strong class="sic-mono">' + _esc(d.id) + '</strong></div>' +
      '<div class="sic-kv"><span>Observed</span><strong><span class="sic-badge ' + meta.cls +
      '"><span class="sic-dot"></span>' + _esc(meta.label) + '</span></strong></div>' +
      '<p class="sic-note">' + note + '</p>';
  }

  function _analyticsPanel(id) {
    var c = _cat();
    var e = c && c.lookup ? c.lookup(id) : null;
    if (!e) return '';
    var declared = (e.evidence || {}).collections || [];
    var spec = e.database || null;
    if (!declared.length && !spec) {
      return '<div class="sic-sect-l">Observed activity</div>' +
        '<p class="sic-note">This entry declares no collection and no database, so there is ' +
        'nothing here this console can measure. That is a property of the entry, not a failed read.</p>';
    }

    var a = _analytics[id];
    if (!a || a.state === 'idle') {
      return '<div class="sic-sect-l">Observed activity</div>' +
        '<p class="sic-note">Not measured yet.</p>';
    }
    if (a.state === 'running') {
      return '<div class="sic-sect-l">Observed activity</div>' +
        '<p class="sic-note">Reading the declared collections…</p>';
    }

    var head = '<div class="sic-sect-l">Observed activity</div>' +
      '<p class="sic-note"><strong>Read this carefully.</strong> These are documents in the ' +
      'collections this integration DECLARES IT WRITES. A collection can have several writers, so ' +
      'activity here is evidence about the collection, <em>not</em> proof that this rail produced it ' +
      'and <em>not</em> a health verdict for the rail.</p>';

    if (a.error) {
      head += '<p class="sic-note"><strong>Unreadable:</strong> ' + _esc(a.error) +
              ' No figure is shown below, because none was obtained.</p>';
    }

    var rows = (a.colls || []).map(function (r) {
      if (!r.ok) {
        return '<div class="sic-kv"><span class="sic-mono">' + _esc(r.name) + '</span><strong>' +
          '<span class="sic-badge error"><span class="sic-dot"></span>Unreadable</span></strong></div>' +
          '<p class="sic-note">' + _esc(r.error) + '</p>';
      }
      var count = r.atLeast ? ('at least ' + r.docs) : String(r.docs);
      var when  = r.latest
        ? _ago(r.latest) + ' (' + _stamp(r.latest) + ', by ' + _esc(r.field) + ')'
        : (r.reason ? EM + ' — ' + _esc(r.reason) : EM);
      return '<div class="sic-kv"><span class="sic-mono">' + _esc(r.name) + '</span><strong>' +
        _esc(count) + ' doc' + (r.docs === 1 ? '' : 's') + '</strong></div>' +
        '<div class="sic-kv"><span>&nbsp;&nbsp;most recent</span><strong>' + when + '</strong></div>';
    }).join('');

    var foot = '';
    if ((a.colls || []).length) {
      foot += '<p class="sic-note">Counts come from a read capped at ' + ANALYTIC_CAP +
        ' documents per collection. A collection shown as "at least ' + ANALYTIC_CAP +
        '" has more than this console asked for — the true total is NOT known here and must not ' +
        'be read as ' + ANALYTIC_CAP + '.</p>';
    }
    if (a.capped) {
      foot += '<p class="sic-note">' + a.capped + ' further declared collection' +
        (a.capped === 1 ? ' was' : 's were') + ' not examined, to bound the cost of opening ' +
        'this card. They are listed under "Collections written" above.</p>';
    }

    return head + rows + foot + _dbVerdict(a.db);
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

      '<div class="sic-kv"><span>Declared lifecycle</span><strong><span class="sic-badge ' + m.cls +
      '"><span class="sic-dot"></span>' + _esc(m.label) + '</span></strong></div>' +
      '<div class="sic-kv"><span>Observed state</span><strong>' + _chipHtml(i) + '</strong></div>' +
      ((function () {
        var c = _chip(i);
        return c ? '<p class="sic-note"><strong>Why ' + _esc(c.label) + ':</strong> ' +
                   _esc(c.why) + '</p>' : '';
      })()) +
      '<div class="sic-kv"><span>Direction</span><strong>' + _esc(i.direction) + '</strong></div>' +
      '<div class="sic-kv"><span>Category</span><strong>' + _esc(i.category) + '</strong></div>' +
      '<div class="sic-kv"><span>Live signal</span><strong>' + _liveSignal(i) + '</strong></div>' +
      _workspaceKv(i) +
      _liveState(i.id) +

      '<div class="sic-sect-l">What it does</div>' +
      '<p style="font-size:12.5px;color:var(--sic-muted);line-height:1.6">' + _esc(i.summary) + '</p>' +

      '<div class="sic-sect-l">Health</div>' +
      '<p style="font-size:12.5px;color:var(--sic-muted);line-height:1.6">' +
      _esc((i.health || {}).note || 'No health signal.') + '</p>' +

      _analyticsPanel(i.id) +

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

  /* ── The operational workspace (C3) ─────────────────────────────────
     Three things an operator can confuse, kept as three rows: CONFIGURATION
     (the secrets required, and whether each is provisioned), OBSERVABLE
     CAPABILITY (the observed-state chip and the stage evidence), and the
     OPERATIONAL WORKSPACE — where the rail is actually USED. This console
     measures; the workspace acts. A link is rendered only for a route inside
     AdminOS (admin-os.html#section or #section/tab); anything else is dropped
     rather than rendered, so a catalogue edit cannot plant a URL. */
  var _WORKSPACE_ROUTE = /^admin-os\.html#[a-z]+(\/[a-z-]+)?$/;
  function _workspaceKv(i) {
    var w = i && i.workspace;
    if (!w || typeof w.route !== 'string' || !_WORKSPACE_ROUTE.test(w.route)) return '';
    return '<div class="sic-kv"><span>Operational workspace</span><strong>' +
      '<a class="sic-linkfig" href="' + _esc(w.route) + '" data-sic-workspace="' + _esc(i.id) + '">' +
      _esc(w.label || 'Open workspace') + ' →</a></strong></div>';
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
      _tab === 'gcp'          ? _gcpPanel()          :
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

    /* AFTER the markup is in place, the access-management module is asked to
       paint itself into the element the GCP panel emitted for it. It must run
       here, not earlier: the assignment above replaces everything.

       This is a call INTO a separate module, not a write. Nothing in THIS file
       mutates any store, which is the guarantee case E4 certifies and sabotage
       S8 proves. The one write surface in this console lives in
       sokoni-gcp-admin.js precisely so that stays true. */
    if (_tab === 'gcp' && typeof window !== 'undefined' && window.SokoniGcpAdmin) {
      try { window.SokoniGcpAdmin.mount('sgaRoot', _opts.gcpAdminOpts || {}); }
      catch (e) {
        /* A failure to paint the write surface must never take the read-only
           cockpit down with it. The evidence is the more important half. */
      }
    }
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
      /* The infrastructure control plane is read ON DEMAND, when an operator
         opens it — never at load. Opening a console is not a reason to query
         the Admin API for the whole estate. */
      if (t === 'gcp') _loadGcp();
      /* Filters mean different things per tab (category vs service type), so a
         tab change clears them rather than silently applying a stale one. */
      _filter = { q: '', type: '', status: '', ops: '' };
      _selected = null;
      _render();
    },
    detailTab: function (t) { _detailTab = t; _render(); },
    /* Open or close a GCP drill-down. In-panel selection, because AdminOS has
       no router — clicking the open one again closes it. */
    gcpDrill: function (id) {
      _gcpDrill = (id && _gcpDrill !== id) ? id : null;
      /* Changing the table closes any entity card opened from the old one, so
         a card can never be left showing an entity the table no longer lists. */
      _gcpPick = null;
      _render();
    },
    /* Open ONE entity's card from inside a drill-down table. */
    gcpPick: function (kind, id) {
      _gcpPick = (kind && id && !(_gcpPick && _gcpPick.kind === kind && _gcpPick.id === id))
        ? { kind: kind, id: id } : null;
      _render();
    },
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
      /* Measurement is ON DEMAND and only for what the operator opened, so the
         cost of this console stays proportional to what is being looked at
         rather than to the size of the catalogue. */
      if (_selected) _analyse(_selected);
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
