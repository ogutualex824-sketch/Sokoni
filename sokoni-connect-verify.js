/* ============================================================================
   SOKONI Connect — verification write surface   sokoni-connect-verify.js v1.0.0
   ============================================================================
   The ONE write path in the Connect console, kept in its own file so
   sokoni-connect-console.js keeps its certified guarantee of containing none —
   exactly as sokoni-gcp-admin.js is kept apart from sokoni-integrations.js.

   Mounted by both platform consoles through the console module:
     admin-os.html    → Communications → Connect
     super-admin.html → Connect

   TWO ACTIONS, BOTH SERVER-GATED
   ------------------------------
     connectRequestVerification         open a video verification against an account
     connectRecordVerificationOutcome   record what the admin observed

   Both are `platform admin only` ON THE SERVER. This file hides nothing that
   the server would have allowed and allows nothing the server would refuse —
   hiding a button is not an authorization control, because the callable can be
   reached directly.

   NO SUCCESS UNTIL THE BACKEND SAYS SO
   ------------------------------------
   Neither action reports success before its callable resolves. A toast shown
   on click would tell an operator a verification exists when the write may
   have failed — and on this surface that means believing a person was asked to
   appear on camera when nobody was.

   NOT DEPLOYED
   ------------
   `connectDispatch` is registered in functions/index.js and is NOT DEPLOYED.
   Until it is, both actions fail with `not-found` / `internal`, and this
   surface says exactly that rather than appearing broken or, worse, appearing
   to have worked.

   A VERIFICATION IS NOT A VERDICT
   -------------------------------
   Recording an outcome writes `sessionOutcome` and nothing else. It does not
   set `verified`, `official`, `faceVerified` or `documentsVerified`, does not
   touch `providerVerification`, and grants no role. The copy on this surface
   says so where the operator reads it, not only in a document nobody opens.
   ========================================================================= */
(function (global) {
  'use strict';

  /* Mirrors functions/shared/connect-authority.js. A value this list does not carry is
     refused by the server, so a drift here produces a refusal, never a wrong write. */
  var REASONS = [
    'identity_verification',
    'business_verification',
    'merchant_verification',
    'rider_verification',
    'supplier_verification',
    'support_escalation',
  ];
  var RESULTS = ['verified', 'not_verified', 'inconclusive', 'abandoned'];

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _fns() {
    if (!global.firebase || !global.firebase.functions) return null;
    try { return global.firebase.functions(); } catch (e) { return null; }
  }

  /* Every op goes through the one dispatcher, matching how the rest of the platform routes. */
  function _call(op, payload) {
    var fns = _fns();
    if (!fns) return Promise.reject(new Error('Cloud Functions are not available on this page.'));
    var fn = fns.httpsCallable('connectDispatch');
    return fn(Object.assign({ op: op }, payload || {})).then(function (r) { return r.data || {}; });
  }

  function _say(el, kind, html) {
    if (!el) return;
    var colour = kind === 'ok' ? 'var(--aos-ok,#71ff00)' : (kind === 'warn' ? '#f5a623' : '#ff4d4d');
    el.innerHTML = '<div class="notif-row" style="border-left:3px solid ' + colour + '">' +
      html + '</div>';
  }

  function _failure(e) {
    var code = (e && e.code) || '';
    if (code === 'not-found' || code === 'functions/not-found' || code === 'internal') {
      return 'The Connect backend is not deployed yet, so nothing was written. ' +
        '(<code>connectDispatch</code> is registered but not released.)';
    }
    if (code === 'permission-denied' || code === 'functions/permission-denied') {
      return 'Refused by the server: ' + _esc((e && e.message) || 'platform admin only') + '.';
    }
    return 'Nothing was written. ' + _esc((e && e.message) || 'The call failed.');
  }

  function _render(root) {
    root.innerHTML =
      '<h3>&#x1F4F9; Verification actions</h3>' +

      /* The consent disclosure, shown to the OPERATOR before they can open a session, so the
         person conducting it knows what the subject will be asked to accept. The server
         refuses to connect a video session without the subject's acceptance regardless. */
      '<p class="aos-muted" style="font-size:12px">' +
      'The subject is shown a consent dialog before joining: camera and microphone will be ' +
      'used, and <strong>Recording: OFF</strong>. The server refuses to connect a video ' +
      'session until they accept, so this cannot be skipped from the interface.</p>' +

      '<div class="compose-form">' +
      '<h4 style="margin:0 0 8px">Open a video verification</h4>' +
      '<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">' +
      '<input type="text" id="cvSubject" placeholder="Account UID to verify" autocomplete="off">' +
      '<select id="cvReason">' +
      REASONS.map(function (r) {
        return '<option value="' + _esc(r) + '">' + _esc(r.replace(/_/g, ' ')) + '</option>';
      }).join('') +
      '</select></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">' +
      '<input type="text" id="cvBusiness" placeholder="Business ID (optional)" autocomplete="off">' +
      '<input type="text" id="cvApplication" placeholder="Application ID (optional)" autocomplete="off">' +
      '</div>' +
      '<textarea id="cvNotes" rows="2" placeholder="Why this verification is being conducted (optional)" style="margin-top:8px"></textarea>' +
      '<button class="aos-btn success" style="margin-top:10px" id="cvOpenBtn">Open verification</button>' +
      '<div id="cvOpenResult" style="margin-top:8px"></div>' +
      '</div>' +

      '<div class="compose-form" style="margin-top:14px">' +
      '<h4 style="margin:0 0 8px">Record an outcome</h4>' +
      '<p class="aos-muted" style="font-size:12px;margin:0 0 8px">' +
      'This records what you <em>observed</em> on the call. It does not verify the account: ' +
      '<code>providerVerification</code> is the authority, and an official identity also needs ' +
      'a passed identity check, a passed face check and a completed human review. ' +
      'An outcome can be recorded <strong>once</strong>.</p>' +
      '<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">' +
      '<input type="text" id="cvVerificationId" placeholder="Verification ID" autocomplete="off">' +
      '<select id="cvResult">' +
      RESULTS.map(function (r) {
        return '<option value="' + _esc(r) + '">' + _esc(r.replace(/_/g, ' ')) + '</option>';
      }).join('') +
      '</select></div>' +
      '<input type="text" id="cvDocs" placeholder="Documents referenced, comma separated (optional)" style="margin-top:8px" autocomplete="off">' +
      '<textarea id="cvOutcomeNotes" rows="2" placeholder="What was observed" style="margin-top:8px"></textarea>' +
      '<button class="aos-btn" style="margin-top:10px" id="cvRecordBtn">Record outcome</button>' +
      '<div id="cvRecordResult" style="margin-top:8px"></div>' +
      '</div>';

    var openBtn = root.querySelector('#cvOpenBtn');
    var recBtn = root.querySelector('#cvRecordBtn');
    if (openBtn) openBtn.addEventListener('click', function () { _open(root); });
    if (recBtn) recBtn.addEventListener('click', function () { _record(root); });
  }

  function _val(root, id) {
    var el = root.querySelector('#' + id);
    return el && el.value ? String(el.value).trim() : '';
  }

  function _open(root) {
    var out = root.querySelector('#cvOpenResult');
    var btn = root.querySelector('#cvOpenBtn');
    var subjectUid = _val(root, 'cvSubject');
    if (!subjectUid) { _say(out, 'err', 'An account UID is required.'); return; }

    /* Disabled while in flight — a double-click must not open two verifications. */
    if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
    if (out) out.innerHTML = '';

    request({
      subjectUid: subjectUid,
      reason: _val(root, 'cvReason'),
      businessId: _val(root, 'cvBusiness') || undefined,
      applicationId: _val(root, 'cvApplication') || undefined,
      notes: _val(root, 'cvNotes') || undefined,
    }).then(function (r) {
      /* Success is reported only from what the SERVER returned. */
      _say(out, 'ok', resultHtml(r));
    }).catch(function (e) {
      _say(out, 'err', '<span>' + _failure(e) + '</span>');
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Open verification'; }
    });
  }

  function _record(root) {
    var out = root.querySelector('#cvRecordResult');
    var btn = root.querySelector('#cvRecordBtn');
    var verificationId = _val(root, 'cvVerificationId');
    if (!verificationId) { _say(out, 'err', 'A verification ID is required.'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Recording…'; }
    if (out) out.innerHTML = '';

    var docs = _val(root, 'cvDocs');
    _call('connectRecordVerificationOutcome', {
      verificationId: verificationId,
      result: _val(root, 'cvResult'),
      notes: _val(root, 'cvOutcomeNotes') || undefined,
      documentsReferenced: docs ? docs.split(',').map(function (s) { return s.trim(); })
        .filter(Boolean) : undefined,
    }).then(function (r) {
      _say(out, 'ok',
        '<span>Outcome <strong>' + _esc(r.sessionOutcome || '?') + '</strong> recorded.</span>' +
        '<span class="aos-muted">This is evidence, not a verdict — authority remains ' +
        _esc(r.authority || 'providerVerification') + '.</span>');
    }).catch(function (e) {
      _say(out, 'err', '<span>' + _failure(e) + '</span>');
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Record outcome'; }
    });
  }

  /* ── The ONE request path (Slice V3) ───────────────────────────────────────
     Used by the form above AND by the contextual "Video verification" actions on
     application cards and verification requests, which prefill the subject from the
     record instead of asking an operator to paste a uid. Same callable, same server
     gate (platform admin only; a purpose outside REASONS is refused; an admin cannot
     verify themselves). Nothing here decides anything: the response is EVIDENCE that a
     session was opened, and the administrative verdict stays with Approve / Reject. */
  function request(input) {
    var i = input || {};
    var subjectUid = String(i.subjectUid || '').trim();
    if (!subjectUid) return Promise.reject(new Error('An account UID is required.'));
    var reason = String(i.reason || '');
    if (REASONS.indexOf(reason) === -1) return Promise.reject(new Error('Reason must be one of: ' + REASONS.join(', ') + '.'));
    return _call('connectRequestVerification', {
      subjectUid: subjectUid,
      reason: reason,
      businessId: i.businessId || undefined,
      applicationId: i.applicationId || undefined,
      notes: i.notes || undefined,
    });
  }
  /* What the server said, and only that. The transport line is the honest media
     state: webrtc is listed only when the server planned it (the subject was online
     and a provider is provisioned); PSTN never appears unless provisioned; an empty
     plan says "no route yet" rather than implying a call will connect. */
  function resultHtml(r) {
    r = r || {};
    return '<span>Verification <strong>' + _esc(r.verificationId || '?') + '</strong> opened' +
      (r.sessionId ? ' (session ' + _esc(r.sessionId) + ')' : '') + '.</span>' +
      '<span class="aos-muted">recording: ' + _esc(r.recording || 'DISABLED') + '</span>' +
      '<span class="aos-muted">' +
      ((r.transportPlan && r.transportPlan.length)
        ? 'route: ' + _esc(r.transportPlan.join(', '))
        : 'no route yet — the subject is offline or no transport is provisioned') +
      '</span>' +
      '<span class="aos-muted">This is evidence, not a verdict — the decision stays with Approve / Reject.</span>';
  }
  global.SokoniConnectVerify = { mount: _render, request: request, resultHtml: resultHtml, failure: _failure, REASONS: REASONS, RESULTS: RESULTS };
})(window);
