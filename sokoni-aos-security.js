/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — SECURITY CENTRE for AdminOS
   sokoni-aos-security.js

   The security posture of the platform, on one surface, built from what an administrator
   can ACTUALLY read.

   ── THE RULE THAT SHAPED THIS PAGE ──────────────────────────────────────────────────────
   A security console is the worst possible place for a decorative number. An invented
   "MFA adoption 68%" or a "device trust 89/128" tells an administrator the estate is
   healthier or sicker than it is, and they act on it. So every figure here is counted from
   a real read, and where a source is not readable the panel says so and shows nothing.

   ── WHAT AN ADMIN MAY READ, MEASURED AGAINST THE DEPLOYED RULESET ───────────────────────
     securityEvents      isAdmin                          ✓ threat feed
     securityAlerts      isAdmin                          ✓ open alerts
     securityIncidents   isAdmin                          ✓ open incidents
     securityAuditLog    isAdmin                          ✓ audit trail
     securityRisk/{uid}  isAdmin OR owner                 ✓ risk profiles
     activeSessions      (admin console collection)       ✓ sessions
     approvalRequests    (admin console collection)       ✓ approvals

     securityMFA/{uid}       request.auth.uid == userId   ✗ OWNER ONLY
     securityDevices/{uid}   request.auth.uid == userId   ✗ OWNER ONLY
     securityStepUp          nobody                       ✗

   MFA enrolment and device trust are deliberately owner-scoped: they are a person's own
   security record, not an administrator's dashboard. So this page does NOT show an MFA
   adoption percentage or a device-trust donut. It names the boundary instead — which is
   more useful than a number, because it tells an administrator why the panel is empty and
   stops the next person "fixing" it by widening a privacy rule.

   ── A DEFECT THIS PAGE DOES NOT INHERIT ─────────────────────────────────────────────────
   The previous events query ordered by `createdAt`. Every writer — four of them in
   functions/index.js — stamps `ts`. Firestore EXCLUDES documents missing the ordered
   field, so that query returned nothing while events were being written, and the panel
   read "No recent security events" on a platform that was recording them. This orders by
   `ts`, and falls back to an unordered read rather than showing a false empty.

   ADDITIVE BY DESIGN. It renders into the existing #securityBody. Every other AdminOS
   section is untouched, and if this module is absent the original panel still runs.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var CSS_ID = 'sokoni-aos-security-css';

  function esc (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Firestore timestamp, epoch ms, or ISO string — whichever a writer used. */
  function ms (t) {
    if (!t) return null;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (t.seconds) return t.seconds * 1000;
    var n = typeof t === 'number' ? t : Date.parse(t);
    return isFinite(n) ? n : null;
  }
  function ago (t) {
    var m = ms(t);
    if (!m) return '—';
    var s = Math.max(0, Math.floor((Date.now() - m) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function when (t) {
    var m = ms(t);
    return m ? new Date(m).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  }

  /* A read that is DENIED is not a read that returned nothing. The distinction is the whole
     point of this page: "we could not look" and "there is nothing there" must never render
     the same, or an administrator reads a permission failure as an all-clear. */
  function safeRead (promise) {
    return Promise.resolve(promise).then(
      function (snap) { return { ok: true, docs: snap && snap.docs ? snap.docs : [] }; },
      function (err) {
        var code = (err && (err.code || err.message)) || 'unavailable';
        return { ok: false, denied: /permission|insufficient/i.test(String(code)), reason: code, docs: [] };
      },
    );
  }

  function rows (r) {
    return r.docs.map(function (d) {
      var o = d.data ? d.data() : {};
      o.id = d.id;
      return o;
    });
  }

  /* ── PRESENTATION ──────────────────────────────────────────────────────────────────── */

  /* A COUNT THAT COULD NOT BE READ IS A DASH. Never 0 — a zero here reads as "no threats",
     which is the most dangerous thing this page could say incorrectly. */
  function stat (label, res, opts) {
    var o = opts || {};
    var known = res.ok;
    var n = known ? res.docs.length : null;
    var tone = !known ? 'unknown' : (n === 0 ? 'calm' : (o.tone || 'warn'));
    return '<div class="secx-stat secx-stat--' + tone + '">' +
      '<div class="secx-stat-ico">' + (o.icon || '🛡️') + '</div>' +
      '<div class="secx-stat-n">' + (known ? n : '—') + (o.plus && known && n >= (o.cap || 50) ? '+' : '') + '</div>' +
      '<div class="secx-stat-l">' + esc(label) + '</div>' +
      '<div class="secx-stat-s">' +
        (known ? esc(o.sub || '') :
          (res.denied ? 'Not readable with this account' : 'Could not be read')) +
      '</div></div>';
  }

  function emptyOr (res, emptyText, build) {
    if (!res.ok) {
      return '<div class="secx-none secx-none--err">' +
        '<b>' + (res.denied ? 'Not readable' : 'Could not be read') + '</b>' +
        '<span>' + esc(res.reason || '') + ' — this is not an empty result. Nothing was read.</span></div>';
    }
    if (!res.docs.length) return '<div class="secx-none"><b>' + esc(emptyText) + '</b></div>';
    return build(rows(res));
  }

  var SEV = { critical: 'crit', high: 'crit', medium: 'warn', low: 'info' };
  function sevOf (v) { return SEV[String(v || '').toLowerCase()] || 'info'; }

  /* Event types are machine tokens (kass_injection_attempt, bot_detected). Shown as written
     — a prettifier that guessed at wording would rename a threat. */
  function evLabel (e) { return e.type || e.event || 'event'; }

  function render (host, d) {
    var openAlerts = d.alerts, incidents = d.incidents, sessions = d.sessions,
        approvals = d.approvals, events = d.events, risk = d.risk, audit = d.audit;

    host.innerHTML =
      '<div class="secx">' +

      /* ── POSTURE STRIP ─────────────────────────────────────────────────── */
      '<div class="secx-strip">' +
        stat('Open alerts', openAlerts, { icon: '🚨', tone: 'crit', sub: 'securityAlerts' }) +
        stat('Open incidents', incidents, { icon: '🔥', tone: 'crit', sub: 'securityIncidents' }) +
        stat('Active sessions', sessions, { icon: '💻', tone: 'info', sub: 'signed in now', plus: true, cap: 30 }) +
        stat('Pending approvals', approvals, { icon: '📋', tone: 'warn', sub: 'awaiting review' }) +
      '</div>' +

      '<div class="secx-grid">' +

        /* ── THREAT FEED ─────────────────────────────────────────────────── */
        '<section class="secx-card secx-card--wide">' +
          '<div class="secx-h"><h3>Threat activity</h3>' +
            '<span class="secx-src">securityEvents</span></div>' +
          emptyOr(events, 'No security events recorded', function (list) {
            return '<ul class="secx-feed">' + list.map(function (e) {
              return '<li class="secx-ev secx-ev--' + sevOf(e.severity) + '">' +
                '<span class="secx-ev-dot"></span>' +
                '<div class="secx-ev-b">' +
                  '<div class="secx-ev-t">' + esc(evLabel(e)) + '</div>' +
                  '<div class="secx-ev-m">' +
                    esc(e.email || e.uid || e.userId || 'system') +
                    (e.ip ? ' · <span class="secx-mono">' + esc(e.ip) + '</span>' : '') +
                    (e.path ? ' · ' + esc(e.path) : '') +
                  '</div>' +
                '</div>' +
                '<time class="secx-ev-w" title="' + esc(when(e.ts || e.createdAt)) + '">' +
                  esc(ago(e.ts || e.createdAt)) + '</time>' +
              '</li>';
            }).join('') + '</ul>';
          }) +
        '</section>' +

        /* ── RISK ────────────────────────────────────────────────────────── */
        '<section class="secx-card">' +
          '<div class="secx-h"><h3>Users at risk</h3><span class="secx-src">securityRisk</span></div>' +
          emptyOr(risk, 'No risk profiles recorded', function (list) {
            return '<ul class="secx-risk">' + list.map(function (u) {
              var score = Number(u.score);
              var has = isFinite(score);
              var band = !has ? 'info' : (score >= 70 ? 'crit' : (score >= 40 ? 'warn' : 'ok'));
              return '<li>' +
                '<div class="secx-risk-u">' +
                  '<div class="secx-risk-n">' + esc(u.email || u.uid || u.id) + '</div>' +
                  '<div class="secx-risk-m">' + esc(u.lastSignal || u.reason || 'no signal recorded') + '</div>' +
                '</div>' +
                /* An absent score is a dash. A risk console that prints 0 for "unscored"
                   tells an administrator the account is safe. */
                '<span class="secx-band secx-band--' + band + '">' + (has ? score : '—') + '</span>' +
              '</li>';
            }).join('') + '</ul>';
          }) +
        '</section>' +

        /* ── OWNER-SCOPED, AND SAID SO ───────────────────────────────────── */
        '<section class="secx-card secx-card--locked">' +
          '<div class="secx-h"><h3>MFA &amp; device trust</h3><span class="secx-src">owner-scoped</span></div>' +
          '<div class="secx-lock">' +
            '<div class="secx-lock-ico">🔒</div>' +
            '<b>Not an administrator\'s to read</b>' +
            '<p><code>securityMFA</code> and <code>securityDevices</code> are readable only by ' +
            'the person they describe. That is deliberate — an enrolment record and a device ' +
            'list are someone\'s own security posture, not a dashboard.</p>' +
            '<p class="secx-lock-warn">There is no adoption percentage here because there is ' +
            'no honest way to count one from this account. Widening those rules to produce a ' +
            'figure would trade every user\'s privacy for a number on a chart.</p>' +
          '</div>' +
        '</section>' +

        /* ── SESSIONS ────────────────────────────────────────────────────── */
        '<section class="secx-card secx-card--wide">' +
          '<div class="secx-h"><h3>Active sessions</h3>' +
            '<span class="secx-src">activeSessions</span></div>' +
          emptyOr(sessions, 'No active sessions tracked', function (list) {
            return '<div class="secx-tw"><table class="secx-t"><thead><tr>' +
              '<th>User</th><th>Device</th><th>IP</th><th>Last active</th><th></th>' +
            '</tr></thead><tbody>' + list.map(function (s) {
              return '<tr>' +
                '<td>' + esc(s.email || s.uid || '—') + '</td>' +
                '<td class="secx-dim">' + esc(s.device || '—') + '</td>' +
                '<td class="secx-mono secx-dim">' + esc(s.ip || '—') + '</td>' +
                '<td class="secx-dim">' + esc(ago(s.lastActive)) + '</td>' +
                '<td class="secx-r"><button class="secx-btn secx-btn--danger" ' +
                  'data-secx="revoke" data-id="' + esc(s.id) + '">Revoke</button></td>' +
              '</tr>';
            }).join('') + '</tbody></table></div>';
          }) +
        '</section>' +

        /* ── AUDIT ───────────────────────────────────────────────────────── */
        '<section class="secx-card">' +
          '<div class="secx-h"><h3>Security audit trail</h3>' +
            '<span class="secx-src">securityAuditLog</span></div>' +
          emptyOr(audit, 'No audit entries recorded', function (list) {
            return '<ul class="secx-aud">' + list.map(function (a) {
              return '<li>' +
                '<div class="secx-aud-a">' + esc(a.action || a.type || 'action') + '</div>' +
                '<div class="secx-aud-m">' + esc(a.actorEmail || a.performedBy || a.uid || 'system') + '</div>' +
                '<time>' + esc(ago(a.ts || a.createdAt || a.at)) + '</time>' +
              '</li>';
            }).join('') + '</ul>';
          }) +
        '</section>' +

        /* ── APPROVALS ───────────────────────────────────────────────────── */
        '<section class="secx-card">' +
          '<div class="secx-h"><h3>Pending approvals</h3>' +
            '<span class="secx-src">approvalRequests</span></div>' +
          emptyOr(approvals, 'Nothing awaiting approval', function (list) {
            return '<ul class="secx-appr">' + list.map(function (a) {
              return '<li>' +
                '<div>' +
                  '<div class="secx-appr-t">' + esc(a.type || 'request') + '</div>' +
                  '<div class="secx-appr-m">' + esc(a.requestedByEmail || a.requestedBy || '—') +
                    ' · ' + esc(ago(a.createdAt)) + '</div>' +
                '</div>' +
                '<div class="secx-appr-b">' +
                  '<button class="secx-btn secx-btn--ok" data-secx="approve" data-id="' + esc(a.id) + '">Approve</button>' +
                  '<button class="secx-btn" data-secx="reject" data-id="' + esc(a.id) + '">Reject</button>' +
                '</div>' +
              '</li>';
            }).join('') + '</ul>';
          }) +
        '</section>' +

      '</div>' +

      /* ── INCIDENTS ─────────────────────────────────────────────────────── */
      '<section class="secx-card secx-card--full">' +
        '<div class="secx-h"><h3>Open incidents</h3>' +
          '<span class="secx-src">securityIncidents</span></div>' +
        emptyOr(incidents, 'No open incidents', function (list) {
          return '<ul class="secx-inc">' + list.map(function (i) {
            return '<li class="secx-inc--' + sevOf(i.severity) + '">' +
              '<span class="secx-tag secx-tag--' + sevOf(i.severity) + '">' +
                esc(i.severity || 'unrated') + '</span>' +
              '<div class="secx-inc-b">' +
                '<div class="secx-inc-t">' + esc(i.title || i.type || 'Incident') + '</div>' +
                '<div class="secx-inc-m">' + esc(i.summary || i.description || '') + '</div>' +
              '</div>' +
              '<time>' + esc(when(i.ts || i.createdAt)) + '</time>' +
            '</li>';
          }).join('') + '</ul>';
        }) +
      '</section>' +

      '<div class="secx-foot">Every figure on this page is counted from a live read. ' +
        'A panel that could not be read says so rather than showing zero.</div>' +
      '</div>';
  }

  /* ── LOAD ──────────────────────────────────────────────────────────────────────────── */
  function skeleton () {
    return '<div class="secx"><div class="secx-strip">' +
      new Array(5).join('<div class="secx-stat secx-skel"></div>') +
      '</div><div class="secx-grid">' +
      new Array(5).join('<div class="secx-card secx-skel secx-skel--card"></div>') +
      '</div></div>';
  }

  function mount (opts) {
    var o = opts || {};
    var host = o.host || document.getElementById('securityBody');
    var db = o.db;
    if (!host) return Promise.resolve(false);
    injectCss();
    host.innerHTML = skeleton();
    if (!db) {
      host.innerHTML = '<div class="secx"><div class="secx-none secx-none--err">' +
        '<b>Security data is not available</b><span>No database connection on this page.</span>' +
        '</div></div>';
      return Promise.resolve(false);
    }

    var col = function (n) { return db.collection(n); };
    /* ORDERED BY `ts`. Every writer stamps `ts`; the previous panel ordered by `createdAt`,
       and Firestore excludes documents missing the ordered field — so it showed nothing on a
       platform that was recording events. Each ordered read falls back to an UNORDERED one,
       because a missing index must degrade to "unsorted" rather than to "none". */
    var ordered = function (name, field, limit) {
      return safeRead(col(name).orderBy(field, 'desc').limit(limit).get())
        .then(function (r) {
          if (r.ok || r.denied) return r;
          return safeRead(col(name).limit(limit).get());
        });
    };

    return Promise.all([
      safeRead(col('securityAlerts').where('status', '==', 'open').limit(50).get())
        .then(function (r) { return r.ok ? r : safeRead(col('securityAlerts').limit(50).get()); }),
      safeRead(col('securityIncidents').where('status', '==', 'open').limit(25).get())
        .then(function (r) { return r.ok ? r : safeRead(col('securityIncidents').limit(25).get()); }),
      ordered('activeSessions', 'lastActive', 30),
      safeRead(col('approvalRequests').where('status', '==', 'pending').limit(20).get()),
      ordered('securityEvents', 'ts', 25),
      ordered('securityRisk', 'score', 8),
      ordered('securityAuditLog', 'ts', 12),
    ]).then(function (r) {
      render(host, {
        alerts: r[0], incidents: r[1], sessions: r[2], approvals: r[3],
        events: r[4], risk: r[5], audit: r[6],
      });
      wire(host, o);
      return true;
    });
  }

  /* Actions delegate to the actions AdminOS already owns — this page adds a surface, not a
     second way to revoke a session. */
  function wire (host, o) {
    host.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('[data-secx]');
      if (!b) return;
      var act = b.getAttribute('data-secx'), id = b.getAttribute('data-id');
      var A = o.actions || root.SokoniAOS || {};
      if (act === 'revoke' && typeof A.revokeSession === 'function') return A.revokeSession(id);
      if (act === 'approve' && typeof A.approveRequest === 'function') return A.approveRequest(id);
      if (act === 'reject' && typeof A.rejectRequest === 'function') return A.rejectRequest(id);
    });
  }

  function injectCss () {
    if (document.getElementById(CSS_ID)) return;
    var l = document.createElement('link');
    l.id = CSS_ID; l.rel = 'stylesheet'; l.href = 'sokoni-aos-security.css';
    document.head.appendChild(l);
  }

  var api = { mount: mount, _render: render, _safeRead: safeRead, _ago: ago, _esc: esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniAOSSecurity = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
