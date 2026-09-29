/* ============================================================================
   SOKONI Email Workspace — sokoni-email-workspace.js   v1.0.0
   ============================================================================
   The ONE in-app email surface, mounted by the canonical admin workspace:

     admin-os.html    → Communications → Email        route #comms/email
     super-admin.html → reaches it through its AdminOS link

   WHAT IT IS, AND WHAT IT IS NOT — READ FIRST
   ------------------------------------------
   SOKONI can SEND email (functions/email-service.js: SendGrid, SMTP fallback,
   `emailLogs`) and can SEE what happened to what it sent (the SendGrid event
   webhook marks opened / clicked / bounced). It CANNOT receive human mail: the
   only Inbound Parse host is for DMARC reports, every outbound Reply-To goes to
   the external support@ mailbox, and there is no thread store and no
   In-Reply-To correlation (docs/COMMUNICATIONS_CENSUS_C1.md).

   So this workspace has NO "reply" control. Outbound sending is labelled as
   available; the inbound/two-way mailbox is labelled as NOT PROVISIONED, with
   the state read from the server's own provider-health answer where it exists
   and stated as a code fact where it does not. Nothing here claims a capability
   the platform has not implemented and observed.

   DATA AUTHORITY
     communicationHealth     provisioning + observed liveness — the server's answer
     communicationPlan       what WOULD happen for a recipient — nothing sent
     communicationSend       the admin send path → notify.js (the one engine)
     emailLogs/{id}          what SOKONI sent (admin read) — delivery evidence
   No client write anywhere in this file. No localStorage. No second sender.
   ========================================================================== */
(function (global) {
  'use strict';

  var EM = '—';
  /* Anchors the send path accepts (functions/shared/communication-envelope.js).
     A verification request or an application is NOT an anchor type, so a message
     raised from one of those records is honestly "about the account"; only a
     support ticket can be named. Nothing is invented on this side. */
  var ANCHOR_TYPES = ['order', 'inquiry', 'booking', 'delivery', 'supply', 'support'];

  var _root = null;

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function _db() { return global.firebase.firestore(); }
  function _fns() { return global.firebase.functions(); }
  function _call(name, data) { return _fns().httpsCallable(name)(data || {}).then(function (r) { return (r && r.data) || {}; }); }
  function _when(ts) {
    try { var d = ts && ts.toDate ? ts.toDate() : (ts ? new Date(ts) : null); return d ? d.toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : EM; }
    catch (_) { return EM; }
  }
  function _failure(e) {
    var code = (e && e.code) || '';
    if (/permission-denied/.test(code)) return 'Refused by the server: ' + _esc((e && e.message) || 'platform admin only') + '.';
    if (/unauthenticated/.test(code)) return 'Sign in required.';
    if (/failed-precondition|invalid-argument/.test(code)) return 'Not sent: ' + _esc((e && e.message) || code) + '.';
    return 'Nothing was sent. ' + _esc((e && e.message) || 'The call failed.');
  }
  function _say(el, kind, html) {
    if (!el) return;
    var colour = kind === 'ok' ? 'var(--aos-accent,#71ff00)' : (kind === 'warn' ? '#f5a623' : '#ff4d4d');
    el.innerHTML = '<div class="notif-row" style="border-left:3px solid ' + colour + ';margin-top:8px">' + html + '</div>';
  }

  /* ── 1. Inbound mail: the honest state ────────────────────────────────── */
  async function _renderInbound(el) {
    el.innerHTML = '<div class="aos-spinner"><div></div></div>';
    var health = null, err = null;
    try { health = await _call('communicationHealth'); } catch (e) { err = e; }
    var rows = (health && health.rows) || [];
    var byId = {}; rows.forEach(function (r) { if (r && r.provider) byId[r.provider] = r; });
    var chainEmail = (health && health.chains && health.chains.email) || null;
    var sendgrid = byId.sendgrid || null, smtp = byId.smtp || null, workspace = byId.google_workspace || null;
    var prov = function (r) { return r ? (r.provisioned === true ? 'provisioned' : r.provisioned === false ? 'not provisioned' : 'unknown') : 'unknown'; };
    var live = function (r) { return r && r.liveness ? String(r.liveness) : 'unobserved'; };
    /* Outbound is a server answer. Inbound is a server answer where the server has one
       (a human-mailbox credential) and a CODE FACT where it does not — labelled as such,
       never dressed up as an observation. */
    el.innerHTML =
      '<div class="ew-grid">' +
        '<div class="ew-card">' +
          '<div class="ew-h">Outbound email</div>' +
          (err ? '<p class="aos-muted">Provider health could not be read: ' + _failure(err) + '</p>' :
          '<div class="ew-kv"><span>SendGrid</span><strong>' + _esc(prov(sendgrid)) + ' &middot; ' + _esc(live(sendgrid)) + '</strong></div>' +
          '<div class="ew-kv"><span>SMTP fallback</span><strong>' + _esc(prov(smtp)) + ' &middot; ' + _esc(live(smtp)) + '</strong></div>' +
          '<div class="ew-kv"><span>Email chain</span><strong>' + _esc(chainEmail ? (Array.isArray(chainEmail) ? chainEmail.join(' → ') : JSON.stringify(chainEmail)) : EM) + '</strong></div>' +
          '<p class="aos-muted" style="font-size:11.5px">' + _esc((health && health.measures) || '') + '. ' + _esc((health && health.doesNotMeasure) || '') + '</p>') +
        '</div>' +
        '<div class="ew-card ew-warn" id="ewInbound" data-inbound="not-provisioned">' +
          '<div class="ew-h">Inbound mail &amp; two-way threads: <span class="status-badge st-warn">not provisioned</span></div>' +
          '<div class="ew-kv"><span>Human mailbox transport (server)</span><strong>' + _esc(prov(workspace)) + '</strong></div>' +
          '<div class="ew-kv"><span>Inbound Parse host for a human mailbox</span><strong>none &mdash; only <span class="aos-mono">reports.mysokoni.co.ke</span> (DMARC reports) is parsed</strong></div>' +
          '<div class="ew-kv"><span>Thread store / In-Reply-To correlation</span><strong>not implemented</strong></div>' +
          '<div class="ew-kv"><span>In-thread reply headers on outbound</span><strong>not implemented</strong></div>' +
          '<p class="aos-muted" style="font-size:11.5px">Replies to SOKONI mail go to the external <span class="aos-mono">support@mysokoni.co.ke</span> mailbox and are answered there. Until inbound is built <em>and observed</em>, there is no reply-from-here; this page does not offer one. Items marked "not implemented" are code facts, not measurements.</p>' +
        '</div>' +
      '</div>';
  }

  /* ── 2. Message a person: plan first, then send, through the one engine ── */
  function _renderComposer(el) {
    el.innerHTML =
      '<div class="compose-form" id="ewComposer">' +
        '<h3>&#x2709;&#xFE0F; Message a person</h3>' +
        '<p class="aos-muted" style="font-size:12px;margin:0 0 8px">Sent through the notification engine as an admin message; the engine chooses the channels the person can actually be reached on (email is one of them). <strong>Plan</strong> shows what would happen before anything is sent.</p>' +
        '<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">' +
          '<input type="text" id="ewTo" placeholder="Recipient account UID" autocomplete="off" aria-label="Recipient uid">' +
          '<select id="ewPriority" aria-label="Priority"><option value="commerce" selected>commerce</option><option value="marketing">marketing</option><option value="critical">critical</option></select>' +
        '</div>' +
        '<input type="text" id="ewSubject" placeholder="Subject" maxlength="200" aria-label="Subject">' +
        '<textarea id="ewBody" placeholder="Message" rows="5" maxlength="4000" aria-label="Message"></textarea>' +
        '<div style="display:grid;grid-template-columns:1fr 2fr;gap:10px">' +
          '<select id="ewAnchorType" aria-label="Anchor type"><option value="">No anchor (about the account)</option>' + ANCHOR_TYPES.map(function (t) { return '<option value="' + t + '">' + t + '</option>'; }).join('') + '</select>' +
          '<input type="text" id="ewAnchorId" placeholder="Anchor id (e.g. a support ticket id)" autocomplete="off" aria-label="Anchor id">' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:8px"><button type="button" class="aos-btn" id="ewPlan">Plan</button><button type="button" class="aos-btn success" id="ewSend" disabled>Send</button></div>' +
        '<div id="ewPlanOut" aria-live="polite"></div><div id="ewSendOut" aria-live="polite"></div>' +
      '</div>';
    var $ = function (id) { return el.querySelector('#' + id); };
    var input = function () {
      var at = $('ewAnchorType').value, ai = $('ewAnchorId').value.trim();
      return { recipientUid: $('ewTo').value.trim(), priority: $('ewPriority').value, subject: $('ewSubject').value.trim(), body: $('ewBody').value.trim(),
               anchorType: at || undefined, anchorId: at ? ai : undefined };
    };
    $('ewPlan').onclick = async function () {
      var i = input(); $('ewSend').disabled = true;
      if (!i.recipientUid) { _say($('ewPlanOut'), 'err', 'A recipient account UID is required.'); return; }
      $('ewPlan').disabled = true;
      try {
        var plan = await _call('communicationPlan', { recipientUid: i.recipientUid, priority: i.priority });
        var reach = plan.reachability || {};
        _say($('ewPlanOut'), (plan.plan && plan.plan.length) ? 'ok' : 'warn',
          '<span><strong>Plan:</strong> ' + _esc((plan.plan || []).join(' → ') || 'nothing can reach this person') + '</span>' +
          '<span class="aos-muted">reachable by: ' + ['present', 'hasPushTarget', 'hasEmail', 'hasPhone'].filter(function (k) { return reach[k]; }).join(', ') + (Object.keys(reach).length ? '' : EM) + '</span>' +
          (plan.explain ? '<span class="aos-muted">' + _esc(plan.explain) + '</span>' : '') +
          '<span class="aos-muted">Nothing has been sent.</span>');
        $('ewSend').disabled = !(plan.plan && plan.plan.length);
      } catch (e) { _say($('ewPlanOut'), 'err', _failure(e)); }
      $('ewPlan').disabled = false;
    };
    $('ewSend').onclick = async function () {
      var i = input();
      if (!i.subject || !i.body) { _say($('ewSendOut'), 'err', 'Subject and message are required.'); return; }
      if ((i.anchorType && !i.anchorId) || (!i.anchorType && $('ewAnchorId').value.trim())) { _say($('ewSendOut'), 'err', 'An anchor needs both a type and an id.'); return; }
      $('ewSend').disabled = true; $('ewSend').textContent = 'Sending…';
      try {
        var r = await _call('communicationSend', { recipientUid: i.recipientUid, subject: i.subject, body: i.body, anchorType: i.anchorType, anchorId: i.anchorId });
        /* Only what the server said. */
        _say($('ewSendOut'), 'ok', '<span><strong>Sent.</strong> ' + _esc(r.explain || '') + '</span>' +
          (r.plan ? '<span class="aos-muted">planned: ' + _esc([].concat(r.plan).join(' → ')) + '</span>' : '') +
          (r.dedupeKey ? '<span class="aos-muted aos-mono">' + _esc(r.dedupeKey) + '</span>' : ''));
        $('ewSend').textContent = 'Sent';
        _renderLog(_root.querySelector('#ewLog'), { uid: i.recipientUid });
      } catch (e) { _say($('ewSendOut'), 'err', _failure(e)); $('ewSend').disabled = false; $('ewSend').textContent = 'Send'; }
    };
  }

  /* ── 3. Sent mail: emailLogs, the delivery evidence ───────────────────── */
  async function _renderLog(el, filter) {
    if (!el) return;
    el.innerHTML = '<div class="aos-spinner"><div></div></div>';
    filter = filter || {};
    try {
      var q = _db().collection('emailLogs');
      if (filter.uid) q = q.where('uid', '==', filter.uid);
      q = q.orderBy('sentAt', 'desc').limit(filter.limit || 50);
      var snap = await q.get();
      var rows = []; snap.forEach(function (d) { rows.push(Object.assign({ id: d.id }, d.data())); });
      if (!rows.length) { el.innerHTML = '<div class="empty-state"><span>&#x1F4ED;</span><p>' + (filter.uid ? 'No email has been sent to this account.' : 'No email in the log.') + '</p></div>'; return; }
      el.innerHTML = '<table class="aos-table"><thead><tr><th>Sent</th><th>To</th><th>From</th><th>Subject</th><th>Status</th><th>Provider</th><th>Evidence</th></tr></thead><tbody>' +
        rows.map(function (m) {
          var ev = [m.openedAt ? 'opened ' + _when(m.openedAt) : null, m.clickedAt ? 'clicked ' + _when(m.clickedAt) : null, m.bouncedAt ? 'bounced ' + _when(m.bouncedAt) : null].filter(Boolean).join(' · ') || EM;
          return '<tr data-email="' + _esc(m.id) + '"><td class="aos-muted">' + _esc(_when(m.sentAt)) + '</td><td>' + _esc(m.to || EM) + '</td><td class="aos-muted">' + _esc(String(m.from || EM).replace(/^"[^"]*"\s*/, '')) + '</td>' +
            '<td>' + _esc(m.subject || EM) + '</td><td><span class="status-badge st-' + _esc(m.status || 'unknown') + '">' + _esc(m.status || 'unknown') + '</span></td><td class="aos-muted">' + _esc(m.provider || EM) + '</td><td class="aos-muted">' + _esc(ev) + '</td></tr>';
        }).join('') + '</tbody></table>';
    } catch (e) {
      /* A failed read must never look like an empty log. */
      el.innerHTML = '<div class="empty-state"><span>&#x26A0;&#xFE0F;</span><p><strong>Could not read emailLogs.</strong></p><p class="aos-muted">' + _failure(e) + '</p></div>';
    }
  }

  /* ── 4. The legacy sections, moved here unchanged (test send + blast) ──── */
  var LEGACY_HTML = `
        <div class="compose-form">
          <h3>&#x2709;&#xFE0F; Send Test Email</h3>
          <p style="color:var(--aos-muted);font-size:12px;margin:0 0 10px">
            Sends a real email rendered with the <strong>production template</strong> &mdash; same header, logo
            and dark-mode CSS as every live SOKONI email. Use it to verify delivery <em>and</em> branding.
          </p>
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
            <input type="email" id="testEmailTo" placeholder="Recipient email" autocomplete="email">
            <select id="testEmailTemplate">
              <option value="">Delivery + branding test</option>
              <option value="welcome">welcome</option>
              <option value="email-verify">email-verify</option>
              <option value="password-reset">password-reset</option>
              <option value="order-confirmation">order-confirmation</option>
              <option value="order-shipped">order-shipped</option>
            </select>
          </div>
          <button class="aos-btn success" style="margin-top:10px" onclick="SokoniAOS.sendTestEmail()">&#x1F9EA; Send Test Email</button>
          <div id="testEmailResult" style="margin-top:10px"></div>
        </div>
        <div class="compose-form">
          <h3>&#x1F4E7; Email Blast</h3>
          <input type="text" id="emailSubject" placeholder="Subject line">
          <textarea id="emailHtml" placeholder="Email body (plain text or HTML)&#x2026;" rows="6"></textarea>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <select id="emailTarget"><option value="all">All Users</option><option value="sellers">Sellers</option><option value="buyers">Buyers</option><option value="drivers">Drivers</option><option value="providers">Providers</option></select>
            <input type="text" id="emailTag" placeholder="Template tag (optional)">
          </div>
          <p style="color:var(--aos-muted);font-size:11px;margin:8px 0">Requires SENDGRID_API_KEY configured in Secret Manager.</p>
          <button class="aos-btn success" style="margin-top:6px" onclick="SokoniAOS.sendEmailBlast()">&#x1F4E8; Send Email Blast</button>
        </div>`;

  function _css() {
    if (document.getElementById('ew-css')) return;
    var st = document.createElement('style'); st.id = 'ew-css';
    st.textContent = '.ew-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-bottom:16px}' +
      '.ew-card{background:var(--aos-surface);border:1px solid var(--aos-border);border-radius:var(--aos-radius);padding:14px;min-width:0}' +
      '.ew-card.ew-warn{border-color:rgba(255,152,0,.45)}.ew-h{font-weight:700;margin-bottom:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
      '.ew-kv{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;padding:4px 0;border-bottom:1px solid var(--aos-border)}.ew-kv span{color:var(--aos-muted)}.ew-kv strong{text-align:right;word-break:break-word}' +
      '.ew-log-filter{display:flex;gap:8px;align-items:center;margin:0 0 8px;flex-wrap:wrap}';
    document.head.appendChild(st);
  }

  function mount(target) {
    _root = typeof target === 'string' ? document.getElementById(target) : target;
    if (!_root) return false;
    if (!global.firebase || !global.firebase.functions) { _root.innerHTML = '<div class="empty-state"><span>&#x26A0;&#xFE0F;</span><p>Firebase is not available on this page.</p></div>'; return false; }
    _css();
    _root.innerHTML =
      '<div id="ewInboundPanel"></div>' +
      '<div id="ewComposerPanel"></div>' +
      '<div class="compose-form"><h3>&#x1F4E4; Sent mail (delivery evidence)</h3>' +
        '<div class="ew-log-filter"><input type="text" class="aos-input" id="ewLogUid" placeholder="Filter by account UID" style="max-width:280px" aria-label="Filter by account uid"><button type="button" class="aos-btn-sm" id="ewLogGo">Filter</button><button type="button" class="aos-btn-sm" id="ewLogAll">All</button></div>' +
        '<div id="ewLog"></div></div>' +
      '<div id="ewLegacy">' + LEGACY_HTML + '</div>';
    _renderInbound(_root.querySelector('#ewInboundPanel'));
    _renderComposer(_root.querySelector('#ewComposerPanel'));
    _renderLog(_root.querySelector('#ewLog'));
    _root.querySelector('#ewLogGo').onclick = function () { _renderLog(_root.querySelector('#ewLog'), { uid: _root.querySelector('#ewLogUid').value.trim() }); };
    _root.querySelector('#ewLogAll').onclick = function () { _root.querySelector('#ewLogUid').value = ''; _renderLog(_root.querySelector('#ewLog')); };
    return true;
  }
  /* Email history for one account, rendered into a record's own container
     (application card, verification request, ticket detail). Read-only evidence. */
  function historyFor(uid, target) {
    var el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    if (!uid) { el.innerHTML = '<div class="empty-state"><p class="aos-muted">This record has no account uid, so there is no email history to show.</p></div>'; return; }
    _renderLog(el, { uid: String(uid), limit: 20 });
  }

  global.SokoniEmailWorkspace = { mount: mount, historyFor: historyFor, ANCHOR_TYPES: ANCHOR_TYPES, version: '1.0.0' };
})(window);
