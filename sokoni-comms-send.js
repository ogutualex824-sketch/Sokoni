/* ============================================================================
   SOKONI Communication Engine — the admin send surface
   sokoni-comms-send.js   v1.0.0
   ============================================================================
   The ONE write path in the communications console, kept in its own file so
   sokoni-comms-console.js keeps its certified guarantee of containing none —
   exactly as sokoni-gcp-admin.js is kept apart from sokoni-integrations.js.

   Mounted by both platform consoles through the console module.

   PLAN BEFORE SEND
   ----------------
   The operator presses Plan first and sees the channel decision — including
   every channel that was ruled out and why — before anything is sent. "Why
   didn't we text them?" is a question someone asks about a bill, and the
   answer belongs on the screen where the decision was made.

   Nothing is sent until the operator presses Send, and success is reported
   only from what the server returned. A toast on click would tell an operator
   a customer was told something they were never told.

   APPROVED COPY, AND HONEST CUSTOM COPY
   -------------------------------------
   Templates are fetched from the server's approved library. A custom message
   is allowed and is recorded as CUSTOM — never dressed up as approved, because
   "what did we tell people" must stay answerable.

   THE ANCHOR IS THE POINT
   -----------------------
   A message sent without an anchor is not wrong, but it will never appear in
   the business timeline an operator later searches. The surface says so rather
   than letting it be discovered months afterwards.

   NOT DEPLOYED
   ------------
   `communicationPlan` / `communicationSend` / `communicationHealth` are
   registered in functions/index.js and are NOT deployed. Until they are, every
   action fails with not-found and this surface says exactly that.
   ========================================================================= */
(function (global) {
  'use strict';

  /* MIRRORS functions/shared/communication-templates.js for LABELS ONLY. The
     library of record is the server's: rendering, channel approval and the
     missing-variable refusal all happen there, and this list is a menu. If the
     two drift, the server refuses — it never renders copy this file invented. */
  var GROUPS = ['order', 'delivery', 'payment', 'account', 'support'];

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _fns() {
    if (!global.firebase || !global.firebase.functions) return null;
    try { return global.firebase.app().functions('us-central1'); } catch (e) { return null; }
  }

  function _call(name, payload) {
    var fns = _fns();
    if (!fns) return Promise.reject(new Error('Cloud Functions are not available on this page.'));
    /* `envelope` not `r`: the callable wrapper's `.data` is the TRANSPORT envelope, not a
       contract field, and naming both `r` made a contract check read `.data` as one. */
    return fns.httpsCallable(name)(payload || {})
      .then(function (envelope) { return (envelope && envelope.data) || {}; });
  }

  function _failure(e) {
    var code = (e && e.code) || '';
    if (/not-found/.test(code)) {
      return 'The communication backend is not deployed yet, so nothing was sent.';
    }
    if (/permission-denied/.test(code)) {
      return 'Refused by the server: ' + _esc((e && e.message) || 'platform admin only') + '.';
    }
    return 'Nothing was sent. ' + _esc((e && e.message) || 'The call failed.');
  }

  function _say(el, tone, html) {
    if (!el) return;
    var colour = tone === 'ok' ? 'var(--aos-ok,#71ff00)'
      : (tone === 'warn' ? '#f5a623' : '#ff4d4d');
    el.innerHTML = '<div class="notif-row" style="border-left:3px solid ' + colour + '">' +
      html + '</div>';
  }

  /**
   * _planHtml(res) — the channel decision, rendered so an operator can read it.
   * Every ruled-out channel is shown with its reason. Nothing is summarised away.
   */
  function _planHtml(res) {
    var plan = (res && res.plan) || [];
    var considered = (res && res.considered) || {};
    var rows = plan.map(function (c) {
      return '<div class="notif-row"><span>' + _esc(c) + '</span>' +
        '<span class="aos-muted">planned</span></div>';
    }).join('') +
      Object.keys(considered).map(function (c) {
        return '<div class="notif-row"><span class="aos-muted">' + _esc(c) + '</span>' +
          '<span class="aos-muted">' + _esc(considered[c]) + '</span></div>';
      }).join('');

    var head = plan.length
      ? '<p><strong>' + _esc(plan.join(' → ')) + '</strong></p>'
      : '<p style="color:#f5a623"><strong>Nothing can reach this person right now</strong> (' +
        _esc((res && res.reason) || '') + ').</p>';

    return head + rows +
      '<p class="aos-muted" style="font-size:12px">Nothing has been sent. ' +
      'A non-critical message never routes to SMS &mdash; that is a policy, not an oversight.' +
      '</p>';
  }

  function _render(root) {
    root.innerHTML =
      '<h3>&#x2709;&#xFE0F; Message a user</h3>' +
      '<p class="aos-muted" style="font-size:12px">' +
      'The server chooses the channel from what can actually reach this person. Press ' +
      '<strong>Plan</strong> first to see the decision and why each other channel was ruled ' +
      'out. Nothing is sent until you press Send.</p>' +

      '<div class="compose-form">' +
      '<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">' +
      '<input type="text" id="csUid" placeholder="Recipient account UID" autocomplete="off">' +
      '<select id="csPriority">' +
      '<option value="commerce">commerce</option>' +
      '<option value="critical">critical (may use SMS)</option>' +
      '<option value="marketing">marketing</option>' +
      '</select></div>' +

      '<div style="display:grid;grid-template-columns:1fr 2fr;gap:10px;margin-top:8px">' +
      '<select id="csAnchorType"><option value="">no anchor</option>' +
      ['order', 'inquiry', 'booking', 'delivery', 'supply', 'support'].map(function (a) {
        return '<option value="' + a + '">' + a + '</option>';
      }).join('') + '</select>' +
      '<input type="text" id="csAnchorId" placeholder="Anchor id (e.g. SK-99420)" autocomplete="off">' +
      '</div>' +
      '<p class="aos-muted" style="font-size:11px;margin:4px 0 0">' +
      'Without an anchor this message will never appear in a business timeline.</p>' +

      '<div style="display:grid;grid-template-columns:1fr 2fr;gap:10px;margin-top:8px">' +
      '<select id="csGroup"><option value="">custom message</option>' +
      GROUPS.map(function (g) { return '<option value="' + g + '">' + g + '</option>'; }).join('') +
      '</select>' +
      '<select id="csTemplate"><option value="">—</option></select>' +
      '</div>' +
      '<div id="csVars" style="margin-top:8px"></div>' +

      '<input type="text" id="csSubject" placeholder="Subject (custom message)" style="margin-top:8px" autocomplete="off">' +
      '<textarea id="csBody" rows="3" placeholder="Message (custom)" style="margin-top:8px"></textarea>' +

      '<div style="display:flex;gap:10px;margin-top:10px">' +
      '<button class="aos-btn" id="csPlanBtn">Plan</button>' +
      '<button class="aos-btn success" id="csSendBtn">Send</button>' +
      '</div>' +
      '<div id="csResult" style="margin-top:8px"></div>' +
      '</div>';

    var groupSel = root.querySelector('#csGroup');
    var tplSel = root.querySelector('#csTemplate');

    /* Template ids come from the server's library via the health/plan round trip? No — they
       are a menu, and the menu is static here on purpose: the SERVER refuses anything it does
       not approve, so a stale menu produces a refusal, never wrong copy. */
    var BY_GROUP = {
      order: ['order_received', 'order_confirmed', 'order_delayed', 'order_cancelled'],
      delivery: ['rider_assigned', 'rider_arriving', 'delivery_delayed'],
      payment: ['payment_received', 'payment_failed', 'refund_processed'],
      account: ['verification_required', 'account_approved', 'account_restricted'],
      support: ['case_received', 'case_updated', 'case_resolved'],
    };

    groupSel.addEventListener('change', function () {
      var g = groupSel.value;
      var ids = BY_GROUP[g] || [];
      tplSel.innerHTML = '<option value="">—</option>' + ids.map(function (id) {
        return '<option value="' + _esc(id) + '">' + _esc(id.replace(/_/g, ' ')) + '</option>';
      }).join('');
      root.querySelector('#csVars').innerHTML = '';
    });

    tplSel.addEventListener('change', function () {
      /* Variable inputs are offered generously: the SERVER decides which are required and
         refuses a render with a blank where a value should be, so an extra box costs nothing
         and a missing one costs a refusal the operator can read. */
      var common = ['name', 'orderRef', 'shop', 'amount', 'reason', 'caseRef', 'update',
        'resolution', 'what'];
      root.querySelector('#csVars').innerHTML = tplSel.value
        ? '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">' +
          common.map(function (v) {
            return '<input type="text" data-var="' + v + '" placeholder="' + v + '" autocomplete="off">';
          }).join('') + '</div>'
        : '';
    });

    root.querySelector('#csPlanBtn').addEventListener('click', function () { _plan(root); });
    root.querySelector('#csSendBtn').addEventListener('click', function () { _send(root); });
  }

  function _val(root, id) {
    var el = root.querySelector('#' + id);
    return el && el.value ? String(el.value).trim() : '';
  }

  function _payload(root) {
    var p = {
      recipientUid: _val(root, 'csUid'),
      priority: _val(root, 'csPriority') || 'commerce',
    };
    var at = _val(root, 'csAnchorType');
    var ai = _val(root, 'csAnchorId');
    if (at && ai) { p.anchorType = at; p.anchorId = ai; }
    var tpl = _val(root, 'csTemplate');
    if (tpl) {
      p.templateId = tpl;
      var vars = {};
      var inputs = root.querySelectorAll('[data-var]');
      for (var i = 0; i < inputs.length; i++) {
        if (inputs[i].value && inputs[i].value.trim()) {
          vars[inputs[i].getAttribute('data-var')] = inputs[i].value.trim();
        }
      }
      p.vars = vars;
    } else {
      p.subject = _val(root, 'csSubject');
      p.body = _val(root, 'csBody');
    }
    return p;
  }

  function _plan(root) {
    var out = root.querySelector('#csResult');
    var btn = root.querySelector('#csPlanBtn');
    var p = _payload(root);
    if (!p.recipientUid) { _say(out, 'err', '<span>A recipient UID is required.</span>'); return; }

    btn.disabled = true; btn.textContent = 'Planning…';
    _call('communicationPlan', p).then(function (r) {
      out.innerHTML = _planHtml(r);
    }).catch(function (e) {
      _say(out, 'err', '<span>' + _failure(e) + '</span>');
    }).then(function () { btn.disabled = false; btn.textContent = 'Plan'; });
  }

  function _send(root) {
    var out = root.querySelector('#csResult');
    var btn = root.querySelector('#csSendBtn');
    var p = _payload(root);
    if (!p.recipientUid) { _say(out, 'err', '<span>A recipient UID is required.</span>'); return; }

    btn.disabled = true; btn.textContent = 'Sending…';
    _call('communicationSend', p).then(function (r) {
      /* Reported from what the SERVER returned, including the parts an operator would rather
         not see: a dedupe, and whether it will ever appear in a timeline. */
      _say(out, 'ok',
        '<span>Sent via <strong>' + _esc((r.plan || []).join(' → ') || '?') + '</strong>' +
        (r.deduped ? ' (deduped — an identical message was already sent, so this one was not)' : '') +
        '.</span>' +
        '<span class="aos-muted">' + _esc(r.source === 'custom' ? 'custom message' :
          'template: ' + (r.templateId || '?')) + '</span>' +
        '<span class="aos-muted">' + (r.anchored
          ? 'anchored — it will appear in the business timeline'
          : 'NOT anchored — it will never appear in a business timeline') + '</span>');
    }).catch(function (e) {
      _say(out, 'err', '<span>' + _failure(e) + '</span>');
    }).then(function () { btn.disabled = false; btn.textContent = 'Send'; });
  }

  /** Provider health, fetched from the server so provisioning is real rather than guessed. */
  function health(target) {
    if (!target) return;
    target.innerHTML = '<div class="aos-spinner"><div></div></div>';
    _call('communicationHealth', {}).then(function (r) {
      var rows = (r.rows || []).map(function (p) {
        var cls = p.state === 'configured' ? 'st-active' : 'st-inactive';
        return '<tr><td>' + _esc(p.provider) + '</td><td>' + _esc(p.channel) + '</td>' +
          '<td>' + _esc(p.role) + '</td>' +
          '<td><span class="status-badge ' + cls + '">' + _esc(p.state) + '</span></td>' +
          '<td class="aos-muted">' + _esc(p.describe || '') + '</td></tr>';
      }).join('');
      target.innerHTML =
        '<div class="dash-section"><h3>&#x1F50C; Provider provisioning</h3>' +
        '<p class="aos-muted" style="font-size:12px"><strong>This measures ' +
        _esc(r.measures || 'provisioning') + ', not ' + _esc(r.doesNotMeasure || 'liveness') +
        '.</strong> A configured provider may still be failing.</p>' +
        '<div class="table-wrap"><table class="aos-table"><thead><tr>' +
        '<th>Provider</th><th>Channel</th><th>Role</th><th>State</th><th></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
    }).catch(function (e) {
      target.innerHTML = '<div class="dash-section"><h3>Provider provisioning</h3>' +
        '<p class="aos-muted">Source unavailable &mdash; ' + _failure(e) + '</p></div>';
    });
  }

  global.SokoniCommsSend = { mount: _render, health: health, GROUPS: GROUPS };
})(window);
