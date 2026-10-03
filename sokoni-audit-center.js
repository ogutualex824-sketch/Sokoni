/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   SokoniAuditCenter — the ONE audit-log view for AdminOS (admin-os.html) and Super Admin (super-admin.html)
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   A renderer only. Each page supplies its own server-authorised feeds (AdminOS: adminGetAuditLogs / getPaymentAuditTrail /
   eccGetAuditLog / platformGetEventLog; Super Admin: auditLog high+critical); this module never reads Firestore itself
   and never writes anything.

   DATA INTEGRITY (CLAUDE.md "UI Data Integrity"):
     • every figure is a COUNT OF THE RECORDS LOADED and says so ("of the N loaded") — no platform totals, no trends,
       no "vs last 7 days"; an unknown is "—", never 0;
     • severity / IP / location / device / environment are shown ONLY when the record carries them — never inferred from
       an action name; a column no loaded record carries is not drawn;
     • a failed load is a neutral "could not load" state, never "0 events".
   SECURITY: every value is escaped; Raw Data is escaped JSON; CSV cells are guarded against formula injection.
   LAYOUT: header · 5 summary cards · filter bar + active chips · table (paged 10/25/50) · detail panel (Overview / Changes /
   Raw Data) — a side panel on wide screens, a full-screen sheet on phones. The host page's sidebar is never touched.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var pick = function (o, keys) { for (var i = 0; i < keys.length; i++) { var v = o && o[keys[i]]; if (v !== undefined && v !== null && v !== '') return v; } return null; };
  var SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

  /* ── normalisation: heterogeneous server records → one shape (nothing invented) ── */
  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (typeof v === 'object' && typeof v._seconds === 'number') return v._seconds * 1000;
    if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000;
    var t = Date.parse(v); return isNaN(t) ? null : t;
  }
  function device(ua) {
    if (!ua) return null;
    var s = String(ua), b = null, os = null;
    if (/Edg\//.test(s)) b = 'Edge'; else if (/OPR\//.test(s)) b = 'Opera'; else if (/Chrome\//.test(s)) b = 'Chrome'; else if (/Firefox\//.test(s)) b = 'Firefox'; else if (/Safari\//.test(s)) b = 'Safari';
    else if (/node|axios|okhttp|python|curl|go-http/i.test(s)) b = 'API client';
    if (/Windows/.test(s)) os = 'Windows'; else if (/Android/.test(s)) os = 'Android'; else if (/iPhone|iPad|iOS/.test(s)) os = 'iOS'; else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS'; else if (/Linux/.test(s)) os = 'Linux';
    return { browser: b || 'Unknown client', os: os, raw: s.slice(0, 300) };
  }
  function normalize(r, feed) {
    r = r || {};
    var d = (r.details && typeof r.details === 'object') ? r.details : {};
    var meta = (r.metadata && typeof r.metadata === 'object') ? r.metadata : {};
    var uid = pick(r, ['adminUid', 'actorUid', 'actor', 'uid', 'userId', 'decidedBy', 'by', 'performedBy']);
    if (uid && typeof uid === 'object') uid = pick(uid, ['uid', 'id', 'email']);
    var email = pick(r, ['adminEmail', 'actorEmail', 'email', 'userEmail']);
    var name = pick(r, ['adminName', 'actorName', 'displayName']);
    var isSystem = !uid && !email ? true : /^(system|automation|scheduler|cron)/i.test(String(uid || email));
    var sev = String(pick(r, ['severity', 'level', 'riskLevel']) || '').toLowerCase();
    var before = pick(r, ['before', 'previous', 'old', 'prev']) || pick(d, ['before', 'previous', 'old', 'from']);
    var after = pick(r, ['after', 'next', 'new', 'updated']) || pick(d, ['after', 'next', 'new', 'to']);
    var detailsText = pick(r, ['description', 'message', 'summary', 'reason']) || (typeof r.details === 'string' ? r.details : null);
    var ip = pick(r, ['ip', 'ipAddress', 'clientIp', 'sourceIp']) || pick(meta, ['ip', 'ipAddress']) || pick(d, ['ip', 'ipAddress']);
    var loc = pick(r, ['location', 'geo', 'city', 'country']) || pick(meta, ['location', 'geo']);
    if (loc && typeof loc === 'object') loc = [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || null;
    var ua = pick(r, ['userAgent', 'ua', 'device']) || pick(meta, ['userAgent', 'ua']);
    return {
      id: String(pick(r, ['id', 'eventId', 'logId']) || ''),
      feed: feed || null,
      at: toMs(pick(r, ['createdAt', 'timestamp', 'at', 'time', 'occurredAt', 'ts'])),
      actor: { uid: uid ? String(uid) : null, email: email ? String(email) : null, name: name ? String(name) : null, system: isSystem },
      action: String(pick(r, ['action', 'event', 'eventType', 'type', 'op']) || '—'),
      category: pick(r, ['category', 'module', 'area', 'collection']),
      resource: pick(r, ['targetId', 'target', 'resource', 'resourceId', 'entityId', 'docId', 'applicationId', 'merchantUid', 'bookingId', 'orderId', 'paymentId']),
      resourceType: pick(r, ['targetType', 'resourceType', 'entityType', 'collection']),
      ip: ip ? String(ip) : null,
      location: loc ? String(loc) : null,
      device: typeof ua === 'string' ? device(ua) : null,
      severity: SEVERITIES.indexOf(sev) >= 0 ? sev : null,
      environment: pick(r, ['environment', 'env']) ? String(pick(r, ['environment', 'env'])) : null,
      summary: detailsText ? String(detailsText) : null,
      before: before === undefined ? null : before,
      after: after === undefined ? null : after,
      raw: r,
    };
  }

  /* ── formatting ── */
  function fmtDate(ms) { if (!ms) return '—'; var d = new Date(ms); return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function fmtTime(ms) { if (!ms) return ''; return new Date(ms).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  function ago(ms) {
    if (!ms) return ''; var s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago';
  }
  function humanAction(a) { return String(a || '—').replace(/[_.:-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, function (c) { return c.toUpperCase(); }); }
  function initials(e) { var s = e.actor.name || e.actor.email || e.actor.uid || ''; var p = s.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean); return ((p[0] || '?')[0] + ((p[1] || '')[0] || '')).toUpperCase(); }
  function actorLabel(e) { return e.actor.system ? (e.actor.uid && !/^system$/i.test(e.actor.uid) ? e.actor.uid : 'System') : (e.actor.name || e.actor.email || e.actor.uid); }
  function actorSub(e) { if (e.actor.system) return 'automated'; return e.actor.name ? (e.actor.email || e.actor.uid) : (e.actor.email && e.actor.uid ? e.actor.uid : ''); }
  function stringify(v) { try { return JSON.stringify(v, function (k, x) { return x && typeof x.toDate === 'function' ? x.toDate().toISOString() : x; }, 2); } catch (_) { return String(v); } }
  function csvCell(v) { var s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }

  /* ── styles (scoped to .sac; injected once) ── */
  var CSS = [
    '.sac{--sac-bg:#0b0e1a;--sac-card:#11152a;--sac-card2:#151a33;--sac-line:rgba(255,255,255,.07);--sac-text:#e8eaf6;--sac-sub:#9aa0c3;--sac-mute:#6b7199;',
    '--sac-accent:#6d5dfc;--sac-accent2:#8b7dff;--sac-crit:#ff4d6a;--sac-high:#ff6b5b;--sac-med:#f5a524;--sac-low:#2ecc8f;--sac-info:#4da3ff;',
    'color:var(--sac-text);font:13px/1.45 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;gap:16px;align-items:flex-start;min-width:0}',
    '.sac *{box-sizing:border-box}.sac-main{flex:1;min-width:0}',
    '.sac-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:18px}',
    '.sac-head h2{margin:0;font-size:22px;font-weight:700;display:flex;align-items:center;gap:8px}.sac-head p{margin:4px 0 0;color:var(--sac-sub);font-size:13px}',
    '.sac-pill{display:inline-flex;min-width:18px;height:18px;padding:0 6px;border-radius:9px;background:var(--sac-accent);color:#fff;font-size:10px;font-weight:700;align-items:center;justify-content:center}',
    '.sac-acts{display:flex;gap:8px;flex-wrap:wrap}',
    '.sac-btn{display:inline-flex;align-items:center;gap:6px;background:var(--sac-card);color:var(--sac-text);border:1px solid var(--sac-line);border-radius:9px;padding:8px 13px;font:inherit;font-weight:600;cursor:pointer}',
    '.sac-btn:hover{border-color:rgba(255,255,255,.18)}.sac-btn:focus-visible,.sac-tr:focus-visible,.sac-tab:focus-visible{outline:2px solid var(--sac-accent2);outline-offset:2px}',
    '.sac-btn.pri{background:var(--sac-accent);border-color:var(--sac-accent);color:#fff}.sac-btn.pri:hover{background:var(--sac-accent2)}.sac-btn[disabled]{opacity:.5;cursor:not-allowed}',
    '.sac-cards{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:16px}',
    '.sac-card{background:var(--sac-card);border:1px solid var(--sac-line);border-radius:14px;padding:14px;display:flex;gap:12px;align-items:center;min-width:0}',
    '.sac-ic{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;flex:none}',
    '.sac-card small{display:block;color:var(--sac-sub);font-size:11.5px}.sac-card b{display:block;font-size:22px;font-weight:700;letter-spacing:-.3px}',
    '.sac-card em{display:block;font-style:normal;color:var(--sac-mute);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.sac-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--sac-card);border:1px solid var(--sac-line);border-radius:12px;padding:10px;margin-bottom:10px}',
    '.sac-search{flex:1 1 240px;display:flex;align-items:center;gap:8px;background:var(--sac-bg);border:1px solid var(--sac-line);border-radius:9px;padding:0 10px}',
    '.sac-search input{flex:1;min-width:0;background:transparent;border:0;color:var(--sac-text);font:inherit;padding:8px 0;outline:none}',
    '.sac-sel,.sac-date{background:var(--sac-bg);color:var(--sac-text);border:1px solid var(--sac-line);border-radius:9px;padding:8px 10px;font:inherit;min-height:36px}',
    '.sac-link{background:none;border:0;color:var(--sac-sub);font:inherit;cursor:pointer;padding:6px}.sac-link:hover{color:var(--sac-text)}',
    '.sac-chips{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px;min-height:8px}',
    '.sac-chip{display:inline-flex;align-items:center;gap:6px;background:var(--sac-card2);border:1px solid var(--sac-line);border-radius:8px;padding:5px 9px;font-size:12px}',
    '.sac-chip button{background:none;border:0;color:var(--sac-sub);cursor:pointer;font-size:14px;line-height:1;padding:0 2px}.sac-chip button:hover{color:var(--sac-text)}',
    '.sac-tablewrap{background:var(--sac-card);border:1px solid var(--sac-line);border-radius:14px;overflow:auto}',
    '.sac-table{width:100%;border-collapse:collapse;min-width:760px}',
    '.sac-table th{text-align:left;font-size:11.5px;font-weight:600;color:var(--sac-sub);padding:12px 14px;border-bottom:1px solid var(--sac-line);white-space:nowrap}',
    '.sac-table td{padding:11px 14px;border-bottom:1px solid var(--sac-line);vertical-align:middle}',
    '.sac-tr{cursor:pointer}.sac-tr:hover td{background:rgba(255,255,255,.025)}.sac-tr.on td{background:rgba(109,93,252,.10)}',
    '.sac-two b{display:block;font-weight:600;font-size:12.5px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sac-two span{display:block;color:var(--sac-mute);font-size:11.5px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sac-actor{display:flex;align-items:center;gap:10px}.sac-av{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#3b3f7a,#6d5dfc);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex:none}',
    '.sac-av.sys{background:#1f2440;color:var(--sac-sub)}',
    '.sac-tag{display:inline-block;margin-left:6px;font-size:10px;padding:1px 6px;border-radius:5px;background:rgba(109,93,252,.18);color:var(--sac-accent2);vertical-align:middle}',
    '.sac-sev{display:inline-block;padding:3px 10px;border-radius:7px;font-size:11.5px;font-weight:600}',
    '.sac-sev.critical{background:rgba(255,77,106,.14);color:var(--sac-crit);border:1px solid rgba(255,77,106,.35)}.sac-sev.high{background:rgba(255,107,91,.12);color:var(--sac-high)}',
    '.sac-sev.medium{background:rgba(245,165,36,.13);color:var(--sac-med)}.sac-sev.low{background:rgba(46,204,143,.12);color:var(--sac-low)}.sac-sev.info{background:rgba(77,163,255,.12);color:var(--sac-info)}',
    '.sac-env{display:inline-block;padding:3px 10px;border-radius:7px;font-size:11.5px;background:rgba(46,204,143,.10);color:var(--sac-low)}',
    '.sac-dash{color:var(--sac-mute)}',
    '.sac-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;color:var(--sac-sub);font-size:12px}',
    '.sac-pages{display:flex;gap:4px;align-items:center;flex-wrap:wrap}.sac-pg{min-width:30px;height:30px;border-radius:8px;border:1px solid transparent;background:none;color:var(--sac-sub);font:inherit;cursor:pointer}',
    '.sac-pg.on{background:var(--sac-accent);color:#fff}.sac-pg:hover:not(.on):not([disabled]){border-color:var(--sac-line);color:var(--sac-text)}.sac-pg[disabled]{opacity:.35;cursor:default}',
    '.sac-state{padding:44px 16px;text-align:center;color:var(--sac-sub)}.sac-state b{display:block;color:var(--sac-text);font-size:15px;margin-bottom:4px}',
    '.sac-skel{height:14px;border-radius:6px;background:linear-gradient(90deg,#161b34,#1f2547,#161b34);background-size:200% 100%;animation:sacsh 1.2s infinite}@keyframes sacsh{to{background-position:-200% 0}}',
    '.sac-detail{width:360px;flex:none;background:var(--sac-card);border:1px solid var(--sac-line);border-radius:14px;position:sticky;top:12px;max-height:calc(100vh - 24px);overflow:auto}',
    '.sac-dh{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--sac-line);font-weight:600}',
    '.sac-x{background:none;border:0;color:var(--sac-sub);font-size:20px;line-height:1;cursor:pointer;padding:2px 6px}.sac-x:hover{color:var(--sac-text)}',
    '.sac-db{padding:16px}.sac-title{display:flex;align-items:center;gap:10px;margin-bottom:6px}.sac-title .sac-ic{width:34px;height:34px}',
    '.sac-title h3{margin:0;font-size:17px}.sac-meta{color:var(--sac-sub);font-size:12px}.sac-meta code{color:var(--sac-mute);font-size:11px;word-break:break-all}',
    '.sac-tabs{display:flex;gap:16px;border-bottom:1px solid var(--sac-line);margin:14px 0 12px}',
    '.sac-tab{background:none;border:0;color:var(--sac-sub);font:inherit;padding:8px 0;cursor:pointer;border-bottom:2px solid transparent}.sac-tab.on{color:var(--sac-text);border-color:var(--sac-accent)}',
    '.sac-kv{display:grid;grid-template-columns:110px 1fr;gap:10px 12px;font-size:12.5px;margin-top:10px}.sac-kv dt{color:var(--sac-sub)}.sac-kv dd{margin:0;word-break:break-word}',
    '.sac-what{background:var(--sac-bg);border:1px solid var(--sac-line);border-radius:10px;padding:12px;font-size:12.5px;color:var(--sac-sub)}.sac-what b{color:var(--sac-text);display:block;margin-bottom:4px}',
    '.sac-pre{background:var(--sac-bg);border:1px solid var(--sac-line);border-radius:10px;padding:12px;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9cdf0;white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto;margin:0}',
    '.sac-diff{display:grid;grid-template-columns:1fr 1fr;gap:8px}.sac-diff h4{margin:0 0 6px;font-size:11.5px;color:var(--sac-sub);font-weight:600}',
    '.sac-qa{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px}.sac-qa .sac-btn{justify-content:center}',
    '.sac-note{margin-top:12px;font-size:11px;color:var(--sac-mute)}',
    '@media (max-width:1280px){.sac-cards{grid-template-columns:repeat(3,minmax(0,1fr))}}',
    '@media (max-width:1100px){.sac{display:block}.sac-detail{position:fixed;inset:0;width:auto;max-height:none;border-radius:0;z-index:1000}}',
    '@media (max-width:640px){.sac-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.sac-card b{font-size:19px}.sac-head h2{font-size:19px}.sac-diff{grid-template-columns:1fr}}',
  ].join('');
  function injectCss(doc) {
    if (!doc || !doc.head || doc.getElementById('sac-style')) return;
    var st = doc.createElement('style'); st.id = 'sac-style'; st.textContent = CSS; doc.head.appendChild(st);
  }

  var SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
  var sevBadge = function (s) { return s ? '<span class="sac-sev ' + esc(s) + '">' + esc(SEV_LABEL[s]) + '</span>' : '<span class="sac-dash">—</span>'; };
  var dash = '<span class="sac-dash">—</span>';

  /**
   * mount(host, opts)
   *   opts.title, opts.subtitle
   *   opts.feeds: [{ key, label, load: (limit) => Promise<record[]> }]   — server-authorised readers supplied by the page
   *   opts.limits: e.g. [50, 200, 500] — "Load more" steps (the feed's own server cap applies)
   */
  function mount(host, opts) {
    if (!host) return null;
    var o = opts || {};
    var doc = host.ownerDocument || G.document;
    injectCss(doc);
    var feeds = (o.feeds || []).filter(function (f) { return f && typeof f.load === 'function'; });
    var limits = (o.limits && o.limits.length ? o.limits : [50, 200, 500]);
    var S = { feed: (feeds[0] || {}).key || null, limitIx: 0, rows: [], state: 'loading', error: null, q: '', sev: '', actorKind: '', from: '', to: '',
      page: 1, per: 10, sel: null, tab: 'overview', seq: 0 };

    function feedOf(k) { return feeds.filter(function (f) { return f.key === k; })[0] || null; }
    function filtered() {
      var q = S.q.trim().toLowerCase(), fromMs = S.from ? Date.parse(S.from + 'T00:00:00') : null, toMs_ = S.to ? Date.parse(S.to + 'T23:59:59.999') : null;
      return S.rows.filter(function (e) {
        if (S.sev === '__none' ? e.severity : (S.sev && e.severity !== S.sev)) return false;
        if (S.actorKind === 'system' && !e.actor.system) return false;
        if (S.actorKind === 'person' && e.actor.system) return false;
        if (fromMs && !(e.at >= fromMs)) return false;
        if (toMs_ && !(e.at <= toMs_)) return false;
        if (q) {
          var hay = [e.action, e.resource, e.resourceType, e.actor.uid, e.actor.email, e.actor.name, e.ip, e.location, e.summary, e.id].join(' ').toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      });
    }
    /* columns that some loaded record actually carries (never draw a column of invented values) */
    function cols(list) {
      var has = function (f) { return list.some(f); };
      return { ip: has(function (e) { return e.ip || e.location; }), device: has(function (e) { return e.device; }), sev: has(function (e) { return e.severity; }), env: has(function (e) { return e.environment; }) };
    }

    function cards() {
      if (S.state !== 'ready') {
        var lbl = ['Events', 'High & critical', 'Unique actors', 'Automated', 'Changes recorded'];
        return '<div class="sac-cards">' + lbl.map(function (l, i) { return card(i, l, S.state === 'error' ? '—' : null, S.state === 'error' ? 'not loaded' : 'Calculating…'); }).join('') + '</div>';
      }
      var n = S.rows.length, scope = 'of the ' + n + ' loaded';
      var hi = S.rows.filter(function (e) { return e.severity === 'high' || e.severity === 'critical'; }).length;
      var withSev = S.rows.some(function (e) { return e.severity; });
      var actors = {}; S.rows.forEach(function (e) { if (!e.actor.system) actors[e.actor.uid || e.actor.email] = 1; });
      var auto = S.rows.filter(function (e) { return e.actor.system; }).length;
      var ch = S.rows.filter(function (e) { return e.before != null || e.after != null; }).length;
      return '<div class="sac-cards">'
        + card(0, 'Events loaded', String(n), (feedOf(S.feed) || {}).label ? 'latest · ' + feedOf(S.feed).label : 'latest first')
        + card(1, 'High & critical', withSev ? String(hi) : '—', withSev ? scope : 'severity not recorded by this feed')
        + card(2, 'Unique actors', String(Object.keys(actors).length), 'people ' + scope)
        + card(3, 'Automated', String(auto), 'system events ' + scope)
        + card(4, 'Changes recorded', String(ch), 'before/after ' + scope)
        + '</div>';
    }
    function card(i, label, val, sub) {
      var IC = [['#6d5dfc', '▤'], ['#ff4d6a', '⚠'], ['#2ecc8f', '👤'], ['#4d7cff', '⚙'], ['#22b07d', '⇄']][i];
      return '<div class="sac-card"><span class="sac-ic" style="background:' + IC[0] + '22;color:' + IC[0] + '" aria-hidden="true">' + IC[1] + '</span><div style="min-width:0"><small>' + esc(label) + '</small>'
        + (val == null ? '<div class="sac-skel" style="width:60px;height:22px;margin:2px 0"></div>' : '<b>' + esc(val) + '</b>') + '<em>' + esc(sub) + '</em></div></div>';
    }

    function filtersBar() {
      return '<div class="sac-filters" role="search">'
        + '<label class="sac-search"><span aria-hidden="true">🔍</span><input type="search" data-sac="q" value="' + esc(S.q) + '" placeholder="Search by actor, action, resource or IP…" aria-label="Search audit events"></label>'
        + (feeds.length > 1 ? '<select class="sac-sel" data-sac="feed" aria-label="Event source">' + feeds.map(function (f) { return '<option value="' + esc(f.key) + '"' + (f.key === S.feed ? ' selected' : '') + '>' + esc(f.label) + '</option>'; }).join('') + '</select>' : '')
        + '<select class="sac-sel" data-sac="sev" aria-label="Severity"><option value="">All severities</option>' + SEVERITIES.map(function (s) { return '<option value="' + s + '"' + (S.sev === s ? ' selected' : '') + '>' + SEV_LABEL[s] + '</option>'; }).join('')
        + '<option value="__none"' + (S.sev === '__none' ? ' selected' : '') + '>Not recorded</option></select>'
        + '<select class="sac-sel" data-sac="actorKind" aria-label="Actor"><option value="">All actors</option><option value="person"' + (S.actorKind === 'person' ? ' selected' : '') + '>People</option><option value="system"' + (S.actorKind === 'system' ? ' selected' : '') + '>System / automated</option></select>'
        + '<input class="sac-date" type="date" data-sac="from" value="' + esc(S.from) + '" aria-label="From date">'
        + '<input class="sac-date" type="date" data-sac="to" value="' + esc(S.to) + '" aria-label="To date">'
        + '<button type="button" class="sac-link" data-sac-act="clear">Clear all</button></div>';
    }
    function chips() {
      var c = [];
      if (S.from || S.to) c.push(['date', (S.from || '…') + ' – ' + (S.to || '…')]);
      if (S.sev) c.push(['sev', 'Severity: ' + (S.sev === '__none' ? 'not recorded' : SEV_LABEL[S.sev])]);
      if (S.actorKind) c.push(['actorKind', 'Actor: ' + (S.actorKind === 'system' ? 'system' : 'people')]);
      if (S.q) c.push(['q', 'Search: ' + S.q]);
      return '<div class="sac-chips">' + c.map(function (x) { return '<span class="sac-chip">' + esc(x[1]) + '<button type="button" data-sac-chip="' + x[0] + '" aria-label="Remove filter ' + esc(x[1]) + '">×</button></span>'; }).join('') + '</div>';
    }

    function table() {
      if (S.state === 'loading') return '<div class="sac-tablewrap"><div style="padding:16px">' + [1, 2, 3, 4, 5].map(function () { return '<div class="sac-skel" style="margin:14px 0"></div>'; }).join('') + '</div></div>';
      if (S.state === 'error') return '<div class="sac-tablewrap"><div class="sac-state" role="alert"><b>We couldn’t load the audit log just now.</b>This is not an empty log. ' + esc(S.error || '') + '<div style="margin-top:12px"><button type="button" class="sac-btn" data-sac-act="retry">Try again</button></div></div></div>';
      var list = filtered(), C = cols(S.rows);
      if (!S.rows.length) return '<div class="sac-tablewrap"><div class="sac-state"><b>No events recorded in this source yet.</b>New activity will appear here.</div></div>';
      if (!list.length) return '<div class="sac-tablewrap"><div class="sac-state"><b>No events match these filters.</b><button type="button" class="sac-link" data-sac-act="clear">Clear filters</button></div></div>';
      var pages = Math.max(1, Math.ceil(list.length / S.per)); if (S.page > pages) S.page = pages;
      var start = (S.page - 1) * S.per, view = list.slice(start, start + S.per);
      var head = '<th scope="col">Time</th><th scope="col">Actor</th><th scope="col">Event</th><th scope="col">Resource</th>'
        + (C.ip ? '<th scope="col">IP / Location</th>' : '') + (C.device ? '<th scope="col">Device / Browser</th>' : '')
        + (C.sev ? '<th scope="col">Severity</th>' : '') + (C.env ? '<th scope="col">Environment</th>' : '');
      var body = view.map(function (e) {
        var key = esc(e.id || String(S.rows.indexOf(e)));
        return '<tr class="sac-tr' + (S.sel === e ? ' on' : '') + '" tabindex="0" data-sac-row="' + S.rows.indexOf(e) + '" aria-label="' + esc(humanAction(e.action) + ' by ' + actorLabel(e)) + '" data-key="' + key + '">'
          + '<td class="sac-two"><b>' + esc(fmtDate(e.at)) + '</b><span>' + esc(fmtTime(e.at)) + '</span></td>'
          + '<td><div class="sac-actor"><span class="sac-av' + (e.actor.system ? ' sys' : '') + '" aria-hidden="true">' + (e.actor.system ? '⚙' : esc(initials(e))) + '</span><div class="sac-two"><b>' + esc(actorLabel(e) || '—') + '</b><span>' + esc(actorSub(e)) + '</span></div></div></td>'
          + '<td class="sac-two"><b>' + esc(humanAction(e.action)) + '</b><span>' + esc(e.category || (feedOf(e.feed) || {}).label || '') + '</span></td>'
          + '<td class="sac-two"><b>' + (e.resource ? esc(e.resource) : '—') + '</b><span>' + esc(e.resourceType || '') + '</span></td>'
          + (C.ip ? '<td class="sac-two"><b>' + (e.ip ? esc(e.ip) : '—') + '</b><span>' + esc(e.location || '') + '</span></td>' : '')
          + (C.device ? '<td class="sac-two"><b>' + (e.device ? esc(e.device.browser) : '—') + '</b><span>' + esc((e.device && e.device.os) || '') + '</span></td>' : '')
          + (C.sev ? '<td>' + sevBadge(e.severity) + '</td>' : '')
          + (C.env ? '<td>' + (e.environment ? '<span class="sac-env">' + esc(e.environment) + '</span>' : dash) + '</td>' : '')
          + '</tr>';
      }).join('');
      var pg = [], lo = Math.max(1, S.page - 2), hi = Math.min(pages, lo + 4); lo = Math.max(1, hi - 4);
      pg.push('<button type="button" class="sac-pg" data-sac-page="' + (S.page - 1) + '"' + (S.page <= 1 ? ' disabled' : '') + ' aria-label="Previous page">‹</button>');
      if (lo > 1) pg.push('<button type="button" class="sac-pg" data-sac-page="1">1</button>' + (lo > 2 ? '<span class="sac-dash">…</span>' : ''));
      for (var p = lo; p <= hi; p++) pg.push('<button type="button" class="sac-pg' + (p === S.page ? ' on' : '') + '" data-sac-page="' + p + '"' + (p === S.page ? ' aria-current="page"' : '') + '>' + p + '</button>');
      if (hi < pages) pg.push((hi < pages - 1 ? '<span class="sac-dash">…</span>' : '') + '<button type="button" class="sac-pg" data-sac-page="' + pages + '">' + pages + '</button>');
      pg.push('<button type="button" class="sac-pg" data-sac-page="' + (S.page + 1) + '"' + (S.page >= pages ? ' disabled' : '') + ' aria-label="Next page">›</button>');
      var more = S.limitIx < limits.length - 1 && S.rows.length >= limits[S.limitIx];
      return '<div class="sac-tablewrap"><table class="sac-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>'
        + '<div class="sac-foot"><span>Showing ' + (start + 1) + ' to ' + Math.min(start + S.per, list.length) + ' of ' + list.length + ' matching · ' + S.rows.length + ' loaded'
        + (more ? ' · <button type="button" class="sac-link" data-sac-act="more" style="color:var(--sac-accent2)">Load more (up to ' + limits[S.limitIx + 1] + ')</button>' : '') + '</span>'
        + '<span class="sac-pages">' + pg.join('') + '<select class="sac-sel" data-sac="per" aria-label="Rows per page" style="margin-left:6px;min-height:30px;padding:4px 8px">' + [10, 25, 50].map(function (n) { return '<option value="' + n + '"' + (n === S.per ? ' selected' : '') + '>' + n + ' / page</option>'; }).join('') + '</select></span></div></div>';
    }

    function detail() {
      var e = S.sel; if (!e) return '';
      var hasChanges = e.before != null || e.after != null;
      var tabs = [['overview', 'Overview'], ['changes', 'Changes'], ['raw', 'Raw Data']];
      var kv = function (k, v) { return '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>'; };
      var bodyHtml;
      if (S.tab === 'changes') {
        bodyHtml = hasChanges ? '<div class="sac-diff"><div><h4>Before</h4><pre class="sac-pre">' + esc(e.before == null ? '—' : stringify(e.before)) + '</pre></div><div><h4>After</h4><pre class="sac-pre">' + esc(e.after == null ? '—' : stringify(e.after)) + '</pre></div></div>'
          : '<div class="sac-what">This event did not record a before/after change.</div>';
      } else if (S.tab === 'raw') {
        bodyHtml = '<pre class="sac-pre">' + esc(stringify(e.raw)) + '</pre>';
      } else {
        var who = actorLabel(e) || 'Someone';
        bodyHtml = '<div class="sac-what"><b>What happened?</b>' + esc(who) + ' — ' + esc(humanAction(e.action)) + (e.resource ? ' on ' + esc(e.resource) : '') + (e.summary ? '. ' + esc(e.summary) : '.') + '</div>'
          + '<dl class="sac-kv">'
          + kv('Actor', esc(actorLabel(e) || '—') + (actorSub(e) ? '<div class="sac-meta">' + esc(actorSub(e)) + '</div>' : ''))
          + kv('Action', '<code>' + esc(e.action) + '</code>')
          + kv('Resource', e.resource ? esc(e.resource) + (e.resourceType ? '<div class="sac-meta">' + esc(e.resourceType) + '</div>' : '') : dash)
          + kv('Source', esc((feedOf(e.feed) || {}).label || '—'))
          + kv('IP address', e.ip ? esc(e.ip) : dash)
          + kv('Location', e.location ? esc(e.location) : dash)
          + kv('Device', e.device ? esc(e.device.browser + (e.device.os ? ' on ' + e.device.os : '')) : dash)
          + kv('Environment', e.environment ? '<span class="sac-env">' + esc(e.environment) + '</span>' : dash)
          + kv('Severity', sevBadge(e.severity))
          + '</dl>';
      }
      return '<aside class="sac-detail" role="dialog" aria-label="Event detail" aria-modal="false">'
        + '<div class="sac-dh"><span>Event detail</span><button type="button" class="sac-x" data-sac-act="close" aria-label="Close event detail">×</button></div><div class="sac-db">'
        + '<div class="sac-title"><span class="sac-ic" style="background:rgba(109,93,252,.16);color:var(--sac-accent2)" aria-hidden="true">◈</span><h3>' + esc(humanAction(e.action)) + '</h3></div>'
        + '<div class="sac-meta">' + esc(e.at ? fmtDate(e.at) + ' at ' + fmtTime(e.at) + ' (' + ago(e.at) + ')' : 'Time not recorded') + '</div>'
        + (e.id ? '<div class="sac-meta">Event ID: <code>' + esc(e.id) + '</code></div>' : '')
        + '<div class="sac-tabs" role="tablist">' + tabs.map(function (t) { return '<button type="button" role="tab" class="sac-tab' + (S.tab === t[0] ? ' on' : '') + '" aria-selected="' + (S.tab === t[0]) + '" data-sac-tab="' + t[0] + '">' + t[1] + (t[0] === 'changes' && hasChanges ? ' •' : '') + '</button>'; }).join('') + '</div>'
        + bodyHtml
        + '<div class="sac-qa">'
        + (e.actor.uid || e.actor.email ? '<button type="button" class="sac-btn" data-sac-act="byActor">Filter by this actor</button>' : '')
        + (e.resource ? '<button type="button" class="sac-btn" data-sac-act="byResource">Filter by this resource</button>' : '')
        + (e.id ? '<button type="button" class="sac-btn" data-sac-act="copyId">Copy event ID</button>' : '')
        + '<button type="button" class="sac-btn" data-sac-act="copyRaw">Copy raw JSON</button></div>'
        + '<div class="sac-note">Read-only. Audit records cannot be edited or deleted from here.</div>'
        + '</div></aside>';
    }

    function render() {
      var keepFocus = doc.activeElement && doc.activeElement.getAttribute ? doc.activeElement.getAttribute('data-sac') : null;
      var caret = keepFocus === 'q' && doc.activeElement.selectionStart;
      host.innerHTML = '<div class="sac"><div class="sac-main">'
        + '<div class="sac-head"><div><h2>' + esc(o.title || 'Audit Logs') + (S.state === 'ready' ? ' <span class="sac-pill" aria-label="' + S.rows.length + ' loaded">' + S.rows.length + '</span>' : '') + '</h2><p>' + esc(o.subtitle || 'Audit trail of administrative and system activity.') + '</p></div>'
        + '<div class="sac-acts"><button type="button" class="sac-btn" data-sac-act="refresh">↻ Refresh</button><button type="button" class="sac-btn pri" data-sac-act="export"' + (S.state === 'ready' && filtered().length ? '' : ' disabled') + '>⬇ Export CSV</button></div></div>'
        + cards() + filtersBar() + chips() + table() + '</div>' + detail() + '</div>';
      if (keepFocus && host.querySelector) {
        var f = host.querySelector('[data-sac="' + keepFocus + '"]');
        if (f && f.focus) { f.focus(); if (caret != null && f.setSelectionRange) try { f.setSelectionRange(caret, caret); } catch (_) {} }
      }
    }

    function load() {
      var f = feedOf(S.feed);
      var my = ++S.seq;   /* a slower earlier load never overwrites a newer one */
      if (!f) { S.state = 'error'; S.error = 'No audit source is configured.'; render(); return Promise.resolve(); }
      S.state = 'loading'; S.sel = null; render();
      return Promise.resolve().then(function () { return f.load(limits[S.limitIx]); }).then(function (list) {
        if (my !== S.seq) return;
        S.rows = (Array.isArray(list) ? list : []).map(function (r) { return normalize(r, f.key); })
          .sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
        S.state = 'ready'; S.page = 1; render();
      }).catch(function (err) {
        if (my !== S.seq) return;
        S.state = 'error'; S.error = (err && err.message) ? String(err.message).slice(0, 160) : ''; S.rows = []; render();
      });
    }

    function exportCsv() {
      var list = filtered(); if (!list.length) return;
      var head = ['time_iso', 'actor', 'actor_uid', 'action', 'resource', 'resource_type', 'ip', 'location', 'device', 'severity', 'environment', 'event_id', 'source'];
      var lines = list.map(function (e) {
        return [e.at ? new Date(e.at).toISOString() : '', actorLabel(e), e.actor.uid || '', e.action, e.resource || '', e.resourceType || '', e.ip || '', e.location || '', e.device ? e.device.browser + (e.device.os ? ' / ' + e.device.os : '') : '',
          e.severity || '', e.environment || '', e.id, (feedOf(e.feed) || {}).label || ''].map(csvCell).join(',');
      });
      var csv = head.join(',') + '\n' + lines.join('\n');
      var a = doc.createElement('a');
      a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
      a.download = 'audit-' + (S.feed || 'log') + '-' + new Date().toISOString().slice(0, 10) + '.csv';
      if (doc.body) { doc.body.appendChild(a); a.click(); doc.body.removeChild(a); } else a.click();
      return csv;
    }
    function copy(text) { try { if (G.navigator && G.navigator.clipboard) return G.navigator.clipboard.writeText(text); } catch (_) {} return Promise.resolve(); }

    host.addEventListener('click', function (ev) {
      var t = ev.target, c = t && t.closest ? t : null; if (!c) return;
      var row = c.closest('[data-sac-row]'), act = c.closest('[data-sac-act]'), chip = c.closest('[data-sac-chip]'), pg = c.closest('[data-sac-page]'), tab = c.closest('[data-sac-tab]');
      if (chip) { var k = chip.getAttribute('data-sac-chip'); if (k === 'date') { S.from = ''; S.to = ''; } else S[k] = ''; S.page = 1; render(); return; }
      if (pg) { if (pg.disabled) return; S.page = Number(pg.getAttribute('data-sac-page')) || 1; render(); return; }
      if (tab) { S.tab = tab.getAttribute('data-sac-tab'); render(); return; }
      if (act) {
        var a = act.getAttribute('data-sac-act');
        if (a === 'clear') { S.q = ''; S.sev = ''; S.actorKind = ''; S.from = ''; S.to = ''; S.page = 1; render(); }
        else if (a === 'refresh' || a === 'retry') load();
        else if (a === 'more') { S.limitIx = Math.min(limits.length - 1, S.limitIx + 1); load(); }
        else if (a === 'export') exportCsv();
        else if (a === 'close') { S.sel = null; render(); }
        else if (a === 'byActor' && S.sel) { S.q = S.sel.actor.email || S.sel.actor.uid || ''; S.page = 1; render(); }
        else if (a === 'byResource' && S.sel) { S.q = String(S.sel.resource || ''); S.page = 1; render(); }
        else if (a === 'copyId' && S.sel) copy(S.sel.id);
        else if (a === 'copyRaw' && S.sel) copy(stringify(S.sel.raw));
        return;
      }
      if (row) { S.sel = S.rows[Number(row.getAttribute('data-sac-row'))] || null; S.tab = 'overview'; render(); }
    });
    host.addEventListener('keydown', function (ev) {
      var t = ev.target;
      if ((ev.key === 'Enter' || ev.key === ' ') && t && t.getAttribute && t.getAttribute('data-sac-row') != null) { ev.preventDefault(); S.sel = S.rows[Number(t.getAttribute('data-sac-row'))] || null; S.tab = 'overview'; render(); }
      else if (ev.key === 'Escape' && S.sel) { S.sel = null; render(); }
    });
    host.addEventListener('input', function (ev) {
      var k = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-sac');
      if (k === 'q') { S.q = String(ev.target.value || '').slice(0, 200); S.page = 1; render(); }
    });
    host.addEventListener('change', function (ev) {
      var k = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-sac');
      if (!k || k === 'q') return;
      var v = String(ev.target.value || '');
      if (k === 'feed') { S.feed = v; S.limitIx = 0; load(); return; }
      if (k === 'per') { S.per = Number(v) || 10; S.page = 1; render(); return; }
      if (k === 'from' || k === 'to') { S[k] = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; }
      else S[k] = v;
      S.page = 1; render();
    });

    load();
    return { reload: load, exportCsv: exportCsv, _state: S };
  }

  G.SokoniAuditCenter = { mount: mount, _internal: { normalize: normalize, device: device, csvCell: csvCell, toMs: toMs } };
}(typeof window !== 'undefined' ? window : globalThis));
