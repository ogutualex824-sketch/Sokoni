/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   SokoniAOSSecurity — the ONE Security view (AdminOS #security; Super Admin reaches it through admin-os.html#security)
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   Renders; never decides. Sources (all admin-only on the server / in the served rules):
     getSecurityScorecard     posture (MEASURED dimensions only — basis measured/declared/unreadable/no_data), MFA
                              adoption, open alerts, incidents, privileged users by role, remediation (criticalIssues)
     activeSessions           active sessions            → revoke via the host's existing revokeSession / revokeAllSessions
     securityEvents           recent security events     (latest N, newest first)
     securityAlerts (open)    the critical / high alert in focus
     approvalRequests         pending approvals          → approve / reject via the host's existing handlers
     adminGetAuditLogs        security-relevant admin actions (action names matching role / claim / permission / MFA …)
   DATA INTEGRITY: the posture score is the server's measured-only score with its coverage stated; declared (static)
   dimensions are shown as "Declared — not measured", never scored; an unknown is "—", never 0; list counts say "latest N".
   Styles: the shared admin stylesheet (SokoniAuditCenter.injectCss, .sac-*) + a few .sas-* layout rules.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var dash = '<span class="sac-dash">—</span>';
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return v; if (typeof v.toMillis === 'function') return v.toMillis(); if (typeof v.toDate === 'function') return v.toDate().getTime(); if (typeof v._seconds === 'number') return v._seconds * 1000; if (typeof v.seconds === 'number') return v.seconds * 1000; var t = Date.parse(v); return isNaN(t) ? null : t; }
  function ago(v) { var ms = toMs(v); if (!ms) return '—'; var s = Math.round((Date.now() - ms) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; }
  function when(v) { var ms = toMs(v); return ms ? new Date(ms).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function human(a) { return String(a || '—').replace(/[_.:-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, function (c) { return c.toUpperCase(); }); }
  var SEVS = ['critical', 'high', 'medium', 'low', 'info'];
  var sevOf = function (r) { var s = String((r && (r.severity || r.level || r.riskLevel)) || '').toLowerCase(); return SEVS.indexOf(s) >= 0 ? s : null; };
  var sevBadge = function (s) { return s ? '<span class="sac-sev ' + esc(s) + '">' + esc(s.charAt(0).toUpperCase() + s.slice(1)) + '</span>' : dash; };
  /* security-relevant admin actions: a SELECTION by action name (labelled as such in the UI), never a metric */
  /* whole WORDS of the action name (split on _ . : - space), so 'banner_saved' is not 'ban' and 'monkey' is not 'key' */
  var SEC_WORDS = /^(roles?|claims?|permissions?|privileges?|privileged|admins?|mfa|2fa|totp|passwords?|keys?|apikey|tokens?|sessions?|security|suspend(ed)?|revoke[ds]?|revocation|ban(ned)?|freeze|frozen|approv(e|ed|al)|decided?|decision|granted|elevat(e|ed|ion))$/i;
  var SEC_ACTION = { test: function (a) { return String(a || '').split(/[_.:\s-]+/).some(function (w) { return SEC_WORDS.test(w); }); } };

  var CSS = [
    '.sas-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}',
    '.sas-tile{background:var(--sac-card);border:1px solid var(--sac-line);border-radius:14px;padding:16px;min-width:0}',
    '.sas-tile h4{margin:0 0 10px;font-size:12.5px;font-weight:600;color:var(--sac-sub);display:flex;justify-content:space-between;gap:8px}',
    '.sas-big{font-size:28px;font-weight:700;letter-spacing:-.5px}.sas-sub{color:var(--sac-mute);font-size:11.5px}',
    '.sas-bar{height:6px;border-radius:4px;background:#1c2142;overflow:hidden;margin-top:10px}.sas-bar i{display:block;height:100%;background:var(--sac-accent);border-radius:4px}',
    '.sas-link{background:none;border:0;color:var(--sac-accent2);font:inherit;font-size:12px;cursor:pointer;padding:8px 0 0}.sas-link:hover{text-decoration:underline}',
    '.sas-posture{display:flex;gap:14px;align-items:center}.sas-ring{flex:none}',
    '.sas-dims{flex:1;min-width:0;font-size:12px}.sas-dims div{display:flex;justify-content:space-between;gap:8px;padding:2px 0}.sas-dims span:first-child{color:var(--sac-sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sas-tabs{display:flex;gap:18px;border-bottom:1px solid var(--sac-line);margin:4px 0 14px;overflow-x:auto}',
    '.sas-tab{background:none;border:0;color:var(--sac-sub);font:inherit;padding:10px 0;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}.sas-tab.on{color:var(--sac-text);border-color:var(--sac-accent)}',
    '.sas-tab:focus-visible,.sas-link:focus-visible{outline:2px solid var(--sac-accent2);outline-offset:2px}',
    '.sas-row3{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:12px;margin-bottom:12px}.sas-row2{display:grid;grid-template-columns:1.6fr 1fr;gap:12px}',
    '.sas-panel{background:var(--sac-card);border:1px solid var(--sac-line);border-radius:14px;padding:14px;min-width:0}',
    '.sas-panel>header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px}.sas-panel>header b{font-size:13.5px}',
    '.sas-list{list-style:none;margin:0;padding:0}.sas-list li{display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--sac-line)}.sas-list li:last-child{border-bottom:0}',
    '.sas-li-main{flex:1;min-width:0}.sas-li-main b{display:block;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sas-li-main span{display:block;color:var(--sac-mute);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sas-ico{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex:none;background:rgba(255,107,91,.12);color:var(--sac-high)}',
    '.sas-donut{display:flex;gap:14px;align-items:center}.sas-legend{font-size:12px;flex:1}.sas-legend div{display:flex;justify-content:space-between;gap:8px;padding:3px 0}.sas-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}',
    '.sas-side{width:330px;flex:none;display:flex;flex-direction:column;gap:12px}.sas-alert{border-color:rgba(255,77,106,.35)}',
    '.sas-alert h3{margin:0 0 2px;font-size:14px;color:var(--sac-crit)}.sas-steps{list-style:none;margin:0;padding:0;counter-reset:st}',
    '.sas-steps li{counter-increment:st;display:flex;gap:10px;padding:8px 0;font-size:12.5px}.sas-steps li::before{content:counter(st);flex:none;width:22px;height:22px;border-radius:50%;background:rgba(109,93,252,.18);color:var(--sac-accent2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}',
    '.sas-tools{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
    '.sas-btn-danger{background:rgba(255,77,106,.12);border-color:rgba(255,77,106,.4);color:var(--sac-crit)}',
    '@media (max-width:1280px){.sas-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.sas-row3{grid-template-columns:1fr 1fr}}',
    '@media (max-width:1100px){.sas-side{width:auto}.sas-row2{grid-template-columns:1fr}}',
    '@media (max-width:640px){.sas-grid,.sas-row3{grid-template-columns:1fr}.sas-big{font-size:24px}}',
  ].join('');

  function ring(pct, label, sub, color) {
    var r = 34, c = 2 * Math.PI * r, p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
    return '<svg class="sas-ring" width="92" height="92" viewBox="0 0 92 92" role="img" aria-label="' + esc(label + (sub ? ' ' + sub : '')) + '">'
      + '<circle cx="46" cy="46" r="' + r + '" fill="none" stroke="#1c2142" stroke-width="9"/>'
      + (pct == null ? '' : '<circle cx="46" cy="46" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + (c * p / 100).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 46 46)"/>')
      + '<text x="46" y="47" text-anchor="middle" fill="#e8eaf6" font-size="20" font-weight="700">' + esc(label) + '</text>'
      + (sub ? '<text x="46" y="62" text-anchor="middle" fill="#6b7199" font-size="9">' + esc(sub) + '</text>' : '') + '</svg>';
  }
  function donut(parts) {
    var total = parts.reduce(function (t, p) { return t + p.n; }, 0), r = 40, c = 2 * Math.PI * r, off = 0;
    var arcs = total ? parts.filter(function (p) { return p.n > 0; }).map(function (p) {
      var len = c * p.n / total, s = '<circle cx="52" cy="52" r="' + r + '" fill="none" stroke="' + p.color + '" stroke-width="12" stroke-dasharray="' + len.toFixed(1) + ' ' + (c - len).toFixed(1) + '" stroke-dashoffset="' + (-off).toFixed(1) + '" transform="rotate(-90 52 52)"/>';
      off += len; return s;
    }).join('') : '';
    return '<svg width="104" height="104" viewBox="0 0 104 104" role="img" aria-label="Device trust of ' + total + ' sampled events"><circle cx="52" cy="52" r="' + r + '" fill="none" stroke="#1c2142" stroke-width="12"/>' + arcs
      + '<text x="52" y="52" text-anchor="middle" fill="#e8eaf6" font-size="20" font-weight="700">' + (total || '—') + '</text><text x="52" y="66" text-anchor="middle" fill="#6b7199" font-size="9">events sampled</text></svg>';
  }

  /**
   * mount(host, opts)
   *   opts.call(name, data) → Promise   (AdminOS _call: callables / adminOsDispatch)
   *   opts.db                            (firebase.firestore() — admin reads already used by AdminOS)
   *   opts.actions: { revokeSession(id), revokeAllSessions(), approveRequest(id), rejectRequest(id), openAudit(), openSection(name) }
   *   opts.links: [{ href, label }]      existing dedicated security pages (no duplicate dashboards here)
   */
  function mount(host, opts) {
    if (!host) return null;
    var o = opts || {}, doc = host.ownerDocument || G.document;
    if (G.SokoniAuditCenter && G.SokoniAuditCenter.injectCss) G.SokoniAuditCenter.injectCss(doc);
    if (doc && doc.head && !doc.getElementById('sas-style')) { var st = doc.createElement('style'); st.id = 'sas-style'; st.textContent = CSS; doc.head.appendChild(st); }
    var A = o.actions || {};
    var S = { tab: 'overview', state: 'loading', sc: null, scErr: null, sessions: null, events: null, alerts: null, approvals: null, audit: null, errs: {}, alertIx: 0, seq: 0 };

    function q(name, fn) { return Promise.resolve().then(fn).then(function (v) { delete S.errs[name]; return v; }, function (e) { S.errs[name] = (e && (e.code || e.message)) || 'unavailable'; return null; }); }
    function docs(snap) { return snap && snap.docs ? snap.docs.map(function (d) { var x = d.data() || {}; x.id = d.id; return x; }) : []; }
    function load() {
      var my = ++S.seq; S.state = 'loading'; render();
      var db = o.db, call = o.call;
      return Promise.all([
        q('scorecard', function () { return call('getSecurityScorecard', {}); }),
        q('sessions', function () { return db.collection('activeSessions').orderBy('lastActive', 'desc').limit(30).get().then(docs); }),
        q('events', function () { return db.collection('securityEvents').orderBy('createdAt', 'desc').limit(30).get().then(docs); }),
        q('alerts', function () { return db.collection('securityAlerts').where('status', '==', 'open').limit(50).get().then(docs); }),
        q('approvals', function () { return db.collection('approvalRequests').where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(20).get().then(docs); }),
        q('audit', function () { return call('adminGetAuditLogs', { limit: 100 }).then(function (d) { return (d && (d.logs || d.items)) || []; }); }),
      ]).then(function (r) {
        if (my !== S.seq) return;
        S.sc = r[0]; S.sessions = r[1]; S.events = r[2]; S.approvals = r[4];
        S.alerts = r[3] ? r[3].slice().sort(function (a, b) { return SEVS.indexOf(sevOf(a) || 'info') - SEVS.indexOf(sevOf(b) || 'info') || (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0); }) : null;
        S.audit = r[5] ? r[5].filter(function (l) { return SEC_ACTION.test(String(l.action || l.event || l.type || '')); }) : null;
        S.alertIx = 0; S.state = 'ready'; render();
      });
    }

    function dim(name) { return S.sc && Array.isArray(S.sc.dimensions) ? S.sc.dimensions.filter(function (d) { return d.name === name; })[0] || null : null; }
    function unavailable(name) { return '<div class="sac-state" style="padding:18px 8px">Not available' + (S.errs[name] ? ' — ' + esc(String(S.errs[name]).slice(0, 80)) : '') + '. This is not an empty list.</div>'; }

    /* ── KPI tiles ── */
    function tiles() {
      var sc = S.sc, cov = sc && sc.coverage;
      var postureVal = sc && sc.totalScore != null ? sc.totalScore : null;
      var measured = sc && Array.isArray(sc.dimensions) ? sc.dimensions.filter(function (d) { return d.basis === 'measured' && d.score != null; }) : [];
      var col = postureVal == null ? '#6b7199' : postureVal >= 80 ? '#2ecc8f' : postureVal >= 60 ? '#f5a524' : '#ff4d6a';
      var posture = '<div class="sas-tile"><h4><span>Security posture</span><span>' + (sc && sc.grade ? esc(String(sc.grade).replace(/\s*\(.*\)/, '')) : '') + '</span></h4>'
        + (S.state === 'loading' ? '<div class="sac-skel" style="height:80px"></div>' : !sc ? unavailable('scorecard')
          : '<div class="sas-posture">' + ring(postureVal, postureVal == null ? '—' : String(postureVal), '/100 measured', col)
          + '<div class="sas-dims">' + measured.slice(0, 5).map(function (d) { return '<div><span>' + esc(d.name) + '</span><b>' + esc(d.score) + '/' + esc(d.maxScore) + '</b></div>'; }).join('')
          + (cov ? '<div class="sas-sub" style="margin-top:4px">' + esc(cov.measured + ' measured · ' + cov.declared + ' declared · ' + (cov.unreadable + cov.noData) + ' not measurable') + '</div>' : '') + '</div></div>')
        + '<button type="button" class="sas-link" data-sas-tab="posture">View all dimensions →</button></div>';
      var m = sc && sc.mfa, mfaPct = m && m.privileged ? Math.round(m.enrolled / m.privileged * 100) : null;
      var mfaD = dim('MFA Adoption');
      var mfa = '<div class="sas-tile"><h4><span>MFA adoption · privileged users</span></h4>'
        + (S.state === 'loading' ? '<div class="sac-skel" style="height:60px"></div>'
          : '<div class="sas-big">' + (mfaPct == null ? '—' : mfaPct + '%') + '</div><div class="sas-sub">' + (m ? esc(m.enrolled + ' of ' + m.privileged + ' enrolled') : esc(mfaD && mfaD.basis === 'no_data' ? 'no privileged users found' : 'not measured')) + '</div>'
          + '<div class="sas-bar" aria-hidden="true"><i style="width:' + (mfaPct || 0) + '%"></i></div>')
        + '<button type="button" class="sas-link" data-sas-tab="posture">MFA details →</button></div>';
      var al = dim('Open Security Alerts'), am = al && al.metrics;
      var alerts = '<div class="sas-tile"><h4><span>Open security alerts</span></h4>'
        + (S.state === 'loading' ? '<div class="sac-skel" style="height:60px"></div>'
          : '<div class="sas-big">' + (am ? esc(am.open) + (am.truncated ? '+' : '') : '—') + '</div><div class="sas-sub">' + (am ? esc(am.critical + ' critical · ' + am.high + ' high') : 'not measured') + '</div>')
        + '<button type="button" class="sas-link" data-sas-tab="alerts">View alerts →</button></div>';
      var inc = dim('Active Incidents'), im = inc && inc.metrics;
      var incidents = '<div class="sas-tile"><h4><span>Active incidents</span></h4>'
        + (S.state === 'loading' ? '<div class="sac-skel" style="height:60px"></div>'
          : '<div class="sas-big">' + (im ? esc(im.open) + (im.truncated ? '+' : '') : '—') + '</div><div class="sas-sub">' + (im ? 'open security incidents' : 'not measured') + '</div>')
        + ((o.links || []).length ? '<a class="sas-link" style="display:inline-block;text-decoration:none" href="' + esc(o.links[0].href) + '">' + esc(o.links[0].label) + ' →</a>' : '') + '</div>';
      return '<div class="sas-grid">' + posture + mfa + alerts + incidents + '</div>';
    }

    function eventsList(limit) {
      if (S.state === 'loading') return '<div class="sac-skel" style="height:120px"></div>';
      if (!S.events) return unavailable('events');
      if (!S.events.length) return '<div class="sac-state" style="padding:18px 8px">No security events recorded yet.</div>';
      return '<ul class="sas-list">' + S.events.slice(0, limit).map(function (e) {
        var where = [e.ip || e.ipAddress, e.location && (typeof e.location === 'object' ? [e.location.city, e.location.country].filter(Boolean).join(', ') : e.location)].filter(Boolean).join(' · ');
        return '<li><span class="sas-ico" aria-hidden="true">⚠</span><div class="sas-li-main"><b>' + esc(human(e.type || e.event || e.action)) + '</b><span>' + esc((e.email || e.uid || 'system') + ' · ' + ago(e.createdAt)) + '</span></div>'
          + '<div class="sas-li-main" style="flex:0 1 150px;text-align:right"><span>' + (where ? esc(where) : '—') + '</span></div>' + sevBadge(sevOf(e)) + '</li>';
      }).join('') + '</ul>';
    }
    function deviceTrust() {
      var d = dim('Device Trust'), mt = d && d.metrics;
      if (S.state === 'loading') return '<div class="sac-skel" style="height:120px"></div>';
      if (!d || d.basis === 'unreadable') return unavailable('scorecard');
      if (!mt || !mt.sampled) return '<div class="sac-state" style="padding:18px 8px">No recent login events to sample.</div>';
      var parts = [{ k: 'Trusted', n: mt.trusted || 0, color: '#2ecc8f' }, { k: 'Untrusted', n: mt.untrusted || 0, color: '#ff4d6a' }, { k: 'Not recorded', n: mt.unrated || 0, color: '#6b7199' }];
      var pct = function (n) { return mt.sampled ? ' (' + Math.round(n / mt.sampled * 100) + '%)' : ''; };
      return '<div class="sas-donut">' + donut(parts) + '<div class="sas-legend">' + parts.map(function (p) { return '<div><span><i class="sas-dot" style="background:' + p.color + '"></i>' + esc(p.k) + '</span><b>' + p.n + esc(pct(p.n)) + '</b></div>'; }).join('')
        + '<div class="sas-sub" style="margin-top:6px">latest ' + esc(mt.sampled) + ' security events</div></div></div>';
    }
    function permissionRisk() {
      var p = S.sc && S.sc.privileged;
      if (S.state === 'loading') return '<div class="sac-skel" style="height:120px"></div>';
      if (!p) return S.sc ? '<div class="sac-state" style="padding:18px 8px">Not measured.</div>' : unavailable('scorecard');
      var label = { super_admin: 'Super admin', admin: 'Admin', owner: 'Owner' };
      var sev = { super_admin: 'high', admin: 'medium', owner: 'medium' };
      var rows = Object.keys(p.byRole || {}).sort(function (a, b) { return (p.byRole[b] || 0) - (p.byRole[a] || 0); });
      return '<div class="sas-big" style="font-size:22px">' + esc(p.total) + (p.truncated ? '+' : '') + '</div><div class="sas-sub" style="margin-bottom:6px">privileged accounts</div>'
        + '<ul class="sas-list">' + rows.map(function (r) { return '<li><div class="sas-li-main"><b>' + esc(label[r] || human(r)) + '</b><span>' + esc(p.byRole[r]) + ' user' + (p.byRole[r] === 1 ? '' : 's') + '</span></div>' + sevBadge(sev[r] || null) + '</li>'; }).join('') + '</ul>';
    }
    function sessionsTable(limit) {
      if (S.state === 'loading') return '<div class="sac-skel" style="height:140px"></div>';
      if (!S.sessions) return unavailable('sessions');
      if (!S.sessions.length) return '<div class="sac-state" style="padding:18px 8px">No active sessions tracked.</div>';
      return '<div class="sac-tablewrap" style="border:0"><table class="sac-table" style="min-width:640px"><thead><tr><th scope="col">User</th><th scope="col">Device</th><th scope="col">Location</th><th scope="col">IP address</th><th scope="col">Last activity</th><th scope="col">Risk</th>' + (A.revokeSession ? '<th scope="col"><span class="sac-dash" style="color:inherit">Actions</span></th>' : '') + '</tr></thead><tbody>'
        + S.sessions.slice(0, limit).map(function (s) {
          return '<tr><td class="sac-two"><b>' + esc(s.email || s.displayName || s.uid || '—') + '</b><span>' + esc(s.uid && (s.email || s.displayName) ? s.uid : '') + '</span></td>'
            + '<td>' + (s.device || s.userAgent ? esc(String(s.device || s.userAgent).slice(0, 60)) : dash) + '</td><td>' + (s.location ? esc(typeof s.location === 'object' ? [s.location.city, s.location.country].filter(Boolean).join(', ') : s.location) : dash) + '</td>'
            + '<td>' + (s.ip ? '<code>' + esc(s.ip) + '</code>' : dash) + '</td><td>' + esc(ago(s.lastActive)) + '</td><td>' + sevBadge(sevOf(s) || (s.riskLevel ? String(s.riskLevel).toLowerCase() : null)) + '</td>'
            + (A.revokeSession ? '<td><button type="button" class="sac-btn sas-btn-danger" data-sas-revoke="' + esc(s.id) + '" aria-label="Revoke session of ' + esc(s.email || s.uid || '') + '">Revoke</button></td>' : '') + '</tr>';
        }).join('') + '</tbody></table></div>';
    }
    function auditCues(limit) {
      if (S.state === 'loading') return '<div class="sac-skel" style="height:140px"></div>';
      if (!S.audit) return unavailable('audit');
      if (!S.audit.length) return '<div class="sac-state" style="padding:18px 8px">No security-relevant admin actions in the latest 100 audit entries.</div>';
      return '<ul class="sas-list">' + S.audit.slice(0, limit).map(function (l) {
        return '<li><div class="sas-li-main"><b>' + esc(human(l.action || l.event || l.type)) + '</b><span>' + esc((l.adminEmail || l.actor || l.adminUid || l.decidedBy || 'system') + (l.targetId || l.target || l.applicationId ? ' → ' + (l.targetId || l.target || l.applicationId) : '')) + '</span></div><span class="sas-sub">' + esc(when(l.createdAt || l.timestamp)) + '</span></li>';
      }).join('') + '</ul>';
    }
    function alertsList() {
      if (S.state === 'loading') return '<div class="sac-skel" style="height:140px"></div>';
      if (!S.alerts) return unavailable('alerts');
      if (!S.alerts.length) return '<div class="sac-state" style="padding:18px 8px">No open security alerts.</div>';
      return '<ul class="sas-list">' + S.alerts.map(function (a, i) {
        return '<li><span class="sas-ico" aria-hidden="true">!</span><div class="sas-li-main"><b>' + esc(a.title || human(a.type || a.event)) + '</b><span>' + esc((a.email || a.uid || a.userId || '—') + ' · ' + ago(a.createdAt)) + '</span></div>' + sevBadge(sevOf(a))
          + '<button type="button" class="sac-btn" data-sas-alert="' + i + '">Details</button></li>';
      }).join('') + '</ul>';
    }
    function approvalsList() {
      if (S.state === 'loading') return '<div class="sac-skel" style="height:140px"></div>';
      if (!S.approvals) return unavailable('approvals');
      if (!S.approvals.length) return '<div class="sac-state" style="padding:18px 8px">No pending approvals.</div>';
      return '<ul class="sas-list">' + S.approvals.map(function (a) {
        return '<li><div class="sas-li-main"><b>' + esc(human(a.type)) + '</b><span>' + esc((a.requestedByEmail || a.requestedBy || '—') + ' · ' + (a.description || '') + ' · ' + when(a.createdAt)) + '</span></div>'
          + (A.approveRequest ? '<button type="button" class="sac-btn" data-sas-approve="' + esc(a.id) + '">Approve</button>' : '')
          + (A.rejectRequest ? '<button type="button" class="sac-btn sas-btn-danger" data-sas-reject="' + esc(a.id) + '">Reject</button>' : '') + '</li>';
      }).join('') + '</ul>';
    }
    function postureDetail() {
      if (S.state === 'loading') return '<div class="sac-skel" style="height:200px"></div>';
      if (!S.sc) return unavailable('scorecard');
      var B = { measured: ['Measured', 'low'], declared: ['Declared — not measured', 'info'], unreadable: ['Could not measure', 'high'], no_data: ['No data yet', 'medium'] };
      return '<div class="sac-tablewrap" style="border:0"><table class="sac-table" style="min-width:560px"><thead><tr><th scope="col">Dimension</th><th scope="col">Score</th><th scope="col">Basis</th><th scope="col">Evidence</th></tr></thead><tbody>'
        + S.sc.dimensions.map(function (d) {
          var b = B[d.basis] || [d.basis || '—', null];
          return '<tr><td><b>' + esc(d.name) + '</b></td><td>' + (d.basis === 'measured' && d.score != null ? esc(d.score + '/' + d.maxScore) : dash) + '</td><td><span class="sac-sev ' + (b[1] || '') + '">' + esc(b[0]) + '</span></td><td class="sac-two"><span style="white-space:normal;max-width:none">' + esc(d.notes || '') + '</span></td></tr>';
        }).join('') + '</tbody></table></div>'
        + '<p class="sac-note">The posture score counts measured dimensions only. Declared dimensions are written into the code and are not checked against live systems.</p>';
    }

    function side() {
      var a = S.alerts && S.alerts[S.alertIx];
      var alertCard = '<div class="sas-panel sas-alert"><header><b style="color:var(--sac-crit)">Alert in focus</b>'
        + (S.alerts && S.alerts.length > 1 ? '<span class="sas-sub"><button type="button" class="sac-pg" data-sas-alertnav="-1" aria-label="Previous alert"' + (S.alertIx <= 0 ? ' disabled' : '') + '>‹</button>' + (S.alertIx + 1) + ' of ' + S.alerts.length + '<button type="button" class="sac-pg" data-sas-alertnav="1" aria-label="Next alert"' + (S.alertIx >= S.alerts.length - 1 ? ' disabled' : '') + '>›</button></span>' : '') + '</header>'
        + (S.state === 'loading' ? '<div class="sac-skel" style="height:140px"></div>' : !S.alerts ? unavailable('alerts') : !a ? '<div class="sac-state" style="padding:16px 4px">No open security alerts.</div>'
          : '<h3>' + esc(a.title || human(a.type || a.event)) + '</h3><div class="sas-sub">' + esc(a.description || a.message || '') + '</div>'
          + '<dl class="sac-kv"><dt>User</dt><dd>' + (a.email || a.uid || a.userId ? esc(a.email || a.uid || a.userId) : dash) + '</dd><dt>Severity</dt><dd>' + sevBadge(sevOf(a)) + '</dd>'
          + '<dt>Time</dt><dd>' + esc(when(a.createdAt)) + '</dd><dt>IP address</dt><dd>' + (a.ip || a.ipAddress ? esc(a.ip || a.ipAddress) : dash) + '</dd>'
          + '<dt>Location</dt><dd>' + (a.location ? esc(typeof a.location === 'object' ? [a.location.city, a.location.country].filter(Boolean).join(', ') : a.location) : dash) + '</dd>'
          + '<dt>Type</dt><dd>' + esc(human(a.type || a.event || '—')) + '</dd></dl>'
          + '<div class="sac-qa" style="grid-template-columns:1fr">' + (A.openAudit ? '<button type="button" class="sac-btn pri" data-sas-act="audit">Investigate in Audit Logs</button>' : '')
          + ((o.links || []).length ? '<a class="sac-btn" style="justify-content:center;text-decoration:none" href="' + esc(o.links[0].href) + '">Open in ' + esc(o.links[0].label) + '</a>' : '') + '</div>')
        + '</div>';
      var issues = S.sc && Array.isArray(S.sc.criticalIssues) ? S.sc.criticalIssues : null;
      var steps = '<div class="sas-panel"><header><b>Remediation steps</b></header>'
        + (S.state === 'loading' ? '<div class="sac-skel" style="height:100px"></div>' : !issues ? unavailable('scorecard')
          : !issues.length ? '<div class="sac-state" style="padding:14px 4px">No critical issues reported by the measured checks.</div>'
          : '<ol class="sas-steps">' + issues.slice(0, 8).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol>')
        + '</div>';
      return '<div class="sas-side">' + alertCard + steps + '</div>';
    }

    function body() {
      if (S.tab === 'sessions') return '<div class="sas-panel"><header><b>Active sessions</b>' + (A.revokeAllSessions && S.sessions && S.sessions.length ? '<button type="button" class="sac-btn sas-btn-danger" data-sas-act="revokeAll">Revoke all sessions</button>' : '') + '</header>' + sessionsTable(100) + '</div>';
      if (S.tab === 'events') return '<div class="sas-panel"><header><b>Security events</b><span class="sas-sub">latest 30</span></header>' + eventsList(30) + '</div>';
      if (S.tab === 'alerts') return '<div class="sas-panel"><header><b>Open security alerts</b><span class="sas-sub">up to 50</span></header>' + alertsList() + '</div>';
      if (S.tab === 'approvals') return '<div class="sas-panel"><header><b>Pending approvals</b></header>' + approvalsList() + '</div>';
      if (S.tab === 'posture') return '<div class="sas-panel"><header><b>Security posture — every dimension</b>' + (S.sc && S.sc.generatedAt ? '<span class="sas-sub">computed ' + esc(when(S.sc.generatedAt)) + '</span>' : '') + '</header>' + postureDetail() + '</div>';
      return '<div class="sas-row3">'
        + '<div class="sas-panel"><header><b>Recent security events</b><button type="button" class="sas-link" data-sas-tab="events">View all</button></header>' + eventsList(5) + '</div>'
        + '<div class="sas-panel"><header><b>Device trust overview</b></header>' + deviceTrust() + '</div>'
        + '<div class="sas-panel"><header><b>Permission risk</b></header>' + permissionRisk() + '</div></div>'
        + '<div class="sas-row2">'
        + '<div class="sas-panel"><header><b>Active sessions</b><button type="button" class="sas-link" data-sas-tab="sessions">View all sessions</button></header>' + sessionsTable(5) + '</div>'
        + '<div class="sas-panel"><header><b>Security audit cues</b>' + (A.openAudit ? '<button type="button" class="sas-link" data-sas-act="audit">View audit logs</button>' : '') + '</header>' + auditCues(6) + '<p class="sac-note">Admin actions whose name mentions roles, permissions, MFA, keys or sessions.</p></div></div>';
    }

    function render() {
      var tabs = [['overview', 'Overview'], ['sessions', 'Sessions'], ['events', 'Events'], ['alerts', 'Alerts'], ['approvals', 'Approvals'], ['posture', 'Posture']];
      host.innerHTML = '<div class="sac"><div class="sac-main">'
        + '<div class="sac-head"><div><h2>Security</h2><p>Monitor security posture, sessions, alerts and privileged access.</p></div>'
        + '<div class="sac-acts"><button type="button" class="sac-btn" data-sas-act="refresh">↻ Refresh</button><button type="button" class="sac-btn pri" data-sas-act="export"' + (S.state === 'ready' ? '' : ' disabled') + '>⬇ Export report</button></div></div>'
        + tiles()
        + '<div class="sas-tabs" role="tablist">' + tabs.map(function (t) { return '<button type="button" role="tab" class="sas-tab' + (S.tab === t[0] ? ' on' : '') + '" aria-selected="' + (S.tab === t[0]) + '" data-sas-tab="' + t[0] + '">' + t[1]
          + (t[0] === 'approvals' && S.approvals && S.approvals.length ? ' <span class="sac-pill">' + S.approvals.length + '</span>' : '') + (t[0] === 'alerts' && S.alerts && S.alerts.length ? ' <span class="sac-pill">' + S.alerts.length + '</span>' : '') + '</button>'; }).join('') + '</div>'
        + body()
        + ((o.links || []).length ? '<div class="sas-tools">' + o.links.map(function (l) { return '<a class="sac-btn" style="text-decoration:none" href="' + esc(l.href) + '">' + esc(l.label) + '</a>'; }).join('') + '</div>' : '')
        + '</div>' + side() + '</div>';
    }

    function exportReport() {
      var rep = { generatedAt: new Date().toISOString(), scorecard: S.sc, openAlerts: S.alerts, activeSessions: (S.sessions || []).map(function (s) { return { uid: s.uid || null, email: s.email || null, ip: s.ip || null, lastActive: toMs(s.lastActive) }; }),
        securityEvents: S.events, pendingApprovals: (S.approvals || []).map(function (a) { return { id: a.id, type: a.type, requestedBy: a.requestedBy || null, createdAt: toMs(a.createdAt) }; }), unavailable: Object.keys(S.errs) };
      var json = JSON.stringify(rep, function (k, v) { return v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v; }, 2);
      var a = doc.createElement('a'); a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(json); a.download = 'security-report-' + new Date().toISOString().slice(0, 10) + '.json';
      if (doc.body) { doc.body.appendChild(a); a.click(); doc.body.removeChild(a); } else a.click();
      return json;
    }

    /* a remount on the same host (AdminOS re-runs its loader after every action) replaces the previous listeners, so one
       click can never act twice; the previous view instance is retired (its pending load can no longer paint) */
    if (typeof host.__sasOff === 'function') host.__sasOff();
    var onClick = function (ev) {
      var t = ev.target; if (!t || !t.closest) return;
      var tab = t.closest('[data-sas-tab]'), act = t.closest('[data-sas-act]'), rv = t.closest('[data-sas-revoke]'), ap = t.closest('[data-sas-approve]'), rj = t.closest('[data-sas-reject]'), al = t.closest('[data-sas-alert]'), an = t.closest('[data-sas-alertnav]');
      if (tab) { S.tab = tab.getAttribute('data-sas-tab'); render(); return; }
      if (an) { if (an.disabled) return; S.alertIx = Math.max(0, Math.min((S.alerts || []).length - 1, S.alertIx + Number(an.getAttribute('data-sas-alertnav')))); render(); return; }
      if (al) { S.alertIx = Number(al.getAttribute('data-sas-alert')) || 0; render(); return; }
      /* the host's handlers confirm, act, toast and reload the panel on success — nothing is claimed here */
      if (rv && A.revokeSession) { A.revokeSession(rv.getAttribute('data-sas-revoke')); return; }
      if (ap && A.approveRequest) { A.approveRequest(ap.getAttribute('data-sas-approve')); return; }
      if (rj && A.rejectRequest) { A.rejectRequest(rj.getAttribute('data-sas-reject')); return; }
      if (act) {
        var a = act.getAttribute('data-sas-act');
        if (a === 'refresh') load();
        else if (a === 'export') exportReport();
        else if (a === 'audit' && A.openAudit) A.openAudit();
        else if (a === 'revokeAll' && A.revokeAllSessions) A.revokeAllSessions();
      }
    };
    host.addEventListener('click', onClick);
    host.__sasOff = function () { S.seq = -1e9; host.removeEventListener && host.removeEventListener('click', onClick); };

    load();
    return { reload: load, exportReport: exportReport, _state: S };
  }

  G.SokoniAOSSecurity = { mount: mount, _internal: { SEC_ACTION: SEC_ACTION, sevOf: sevOf } };
}(typeof window !== 'undefined' ? window : globalThis));
