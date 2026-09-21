/* ============================================================================
   SOKONI GCP ACCESS MANAGEMENT — sokoni-gcp-admin.js                    v1.0.0
   ============================================================================
   The ONLY write surface in the Integrations console. Grants a platform role
   and, optionally, a Google Cloud IAM role — so nobody has to open the Google
   Cloud console to give a colleague access.

   WHY IT IS A SEPARATE FILE FROM sokoni-integrations.js
   -----------------------------------------------------
   That module is certified to contain NO write path at all: case E4 forbids
   the four Firestore write verbs outright and allowlists the read-only ops it
   may dispatch, and sabotage S8 proves the check fires. Adding a write there
   would end a guarantee that has already caught real defects. So the write
   surface lives here, alone, and the read-only console keeps its proof.

   IT WRITES NOTHING ITSELF
   ------------------------
   Every mutation is a callable. There is no Firestore write in this file, no
   claim is computed here, and no IAM policy is assembled here. The browser
   asks; the server decides and refuses.

   THE TWO HALVES ARE DIFFERENT SYSTEMS
   ------------------------------------
     SOKONI role   a Firebase Auth custom claim. Controls this platform.
                   Granted through setUserRole, the EXISTING canonical path —
                   there is no second way to mint an admin, deliberately.
     GCP IAM role  access to the Google Cloud project itself. Granted through
                   superAdminGrantGcpRole.

   They are shown together because an operator thinks of them together, and
   labelled apart because revoking one does not revoke the other. A person
   removed as a SOKONI admin who keeps a project IAM binding still has access
   to the infrastructure.

   SUPER ADMIN ONLY
   ----------------
   Both callables are superAdmin-gated on the server. This module also hides
   itself from a non-superAdmin, but that is a courtesy, not a control — the
   control is the server guard, and hiding a button has never stopped anybody.
   ========================================================================== */
(function () {
  'use strict';

  var EM = '—';

  /* Mirrors functions/gcp-iam-grant.js. Shown so an operator can see what is
     offered before they try; the SERVER list is authoritative and will refuse
     anything not on its own. If these drift, the server wins and says so. */
  var OFFERED_ROLES = [
    { id: 'roles/viewer',                  label: 'Project Viewer — read everything' },
    { id: 'roles/logging.viewer',          label: 'Logs Viewer' },
    { id: 'roles/monitoring.viewer',       label: 'Monitoring Viewer' },
    { id: 'roles/errorreporting.viewer',   label: 'Error Reporting Viewer' },
    { id: 'roles/firebase.viewer',         label: 'Firebase Viewer' },
    { id: 'roles/firebase.developAdmin',   label: 'Firebase Develop Admin' },
    { id: 'roles/datastore.viewer',        label: 'Firestore Viewer' },
    { id: 'roles/run.viewer',              label: 'Cloud Run Viewer' },
    { id: 'roles/cloudfunctions.viewer',   label: 'Cloud Functions Viewer' },
    { id: 'roles/artifactregistry.reader', label: 'Artifact Registry Reader' },
    { id: 'roles/secretmanager.viewer',    label: 'Secret Manager Viewer (names only)' },
  ];

  var PLATFORM_ROLES = [
    { id: 'admin',      label: 'Admin — the AdminOS console' },
    { id: 'superAdmin', label: 'Super Admin — including this page' },
    { id: 'moderator',  label: 'Moderator' },
    { id: 'buyer',      label: 'Buyer (removes elevated access)' },
  ];

  var _root = null, _opts = {}, _busy = false;
  var _result = null;     /* { kind, ok, message, detail } */
  var _confirm = null;    /* the pending action awaiting a typed confirmation */

  function _esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _call(name, payload) {
    var injected = _opts['call_' + name];
    if (typeof injected === 'function') return Promise.resolve(injected(payload));
    if (typeof firebase === 'undefined' || !firebase.functions) {
      return Promise.reject(new Error('Firebase Functions is not available on this page.'));
    }
    return firebase.functions().httpsCallable(name)(payload).then(function (r) { return r.data; });
  }

  /** Is the signed-in operator a super admin? The server enforces this; this
      only decides whether to render the form. */
  function _isSuperAdmin() {
    if (typeof _opts.isSuperAdmin === 'boolean') return _opts.isSuperAdmin;
    try {
      return !!(window.SokoniAOS && window.SokoniAOS._isSuper && window.SokoniAOS._isSuper());
    } catch (e) { return false; }
  }

  /* ── Rendering ─────────────────────────────────────────────────────── */

  function _resultBlock() {
    if (!_result) return '';
    var cls = _result.ok ? 'healthy' : 'error';
    return '<div class="sic-kv"><span>Last action</span><strong>' +
      '<span class="sic-badge ' + cls + '"><span class="sic-dot"></span>' +
      _esc(_result.ok ? 'Done' : 'Refused') + '</span></strong></div>' +
      '<p class="sic-note">' + _esc(_result.message) + '</p>' +
      (_result.detail ? '<p class="sic-note sic-mono">' + _esc(_result.detail) + '</p>' : '');
  }

  /** A typed confirmation. A privilege change behind a single click is not a
      control; the operator retypes the member so an accidental click cannot
      grant anything. */
  function _confirmBlock() {
    if (!_confirm) return '';
    return '<div class="sic-card sic-danger">' +
      '<div class="sic-sect-l">Confirm this change</div>' +
      '<p class="sic-note"><strong>' + _esc(_confirm.verb) + '</strong> ' +
      '<span class="sic-mono">' + _esc(_confirm.role) + '</span> ' +
      (_confirm.verb === 'Revoke' ? 'from ' : 'for ') +
      '<span class="sic-mono">' + _esc(_confirm.member) + '</span>.</p>' +
      (_confirm.kind === 'platform'
        ? '<p class="sic-note">This changes access to <strong>SOKONI</strong>. It does not change ' +
          'Google Cloud access.</p>'
        : '<p class="sic-note">This changes access to the <strong>Google Cloud project</strong>. ' +
          'It does not change SOKONI access.</p>') +
      '<p class="sic-note">Type the member exactly to confirm:</p>' +
      '<input class="sga-in" id="sgaConfirm" placeholder="' + _esc(_confirm.member) + '" ' +
      'oninput="SokoniGcpAdmin._typed(this.value)">' +
      '<div style="margin-top:8px">' +
      '<button class="sga-btn danger" ' + (_confirm.typed === _confirm.member ? '' : 'disabled') +
      ' onclick="SokoniGcpAdmin._commit()">' + _esc(_confirm.verb) + '</button> ' +
      '<button class="sga-btn" onclick="SokoniGcpAdmin._cancel()">Cancel</button>' +
      '</div></div>';
  }

  function _render() {
    if (!_root) return;

    if (!_isSuperAdmin()) {
      _root.innerHTML = '<div class="sic-card">' +
        '<div class="sic-group-h">Access management</div>' +
        '<p class="sic-note">Granting platform or Google Cloud access requires ' +
        '<strong>super admin</strong>. This panel is hidden because you do not hold it — and the ' +
        'server would refuse the call regardless, which is where the actual control lives.</p>' +
        '</div>';
      return;
    }

    _root.innerHTML = '<div class="sic-card">' +
      '<div class="sic-group-h">Access management</div>' +
      '<p class="sic-note">Grant a SOKONI role, a Google Cloud role, or both — without opening ' +
      'the Google Cloud console. <strong>They are separate systems.</strong> Removing someone as ' +
      'a SOKONI admin does not remove their Google Cloud access, and the reverse is also true.</p>' +

      '<div class="sic-sect-l">Who</div>' +
      '<input class="sga-in" id="sgaMember" placeholder="user:someone@sokoni.co.ke" ' +
      'oninput="SokoniGcpAdmin._dirty()">' +
      '<p class="sic-note">For Google Cloud, use the full member form: ' +
      '<span class="sic-mono">user:…</span>, <span class="sic-mono">group:…</span> or ' +
      '<span class="sic-mono">serviceAccount:…</span>. For a SOKONI role, give the Firebase UID.</p>' +

      '<div class="sic-sect-l">SOKONI platform role</div>' +
      '<select class="sga-in" id="sgaPlatformRole">' +
      '<option value="">— no change —</option>' +
      PLATFORM_ROLES.map(function (r) {
        return '<option value="' + _esc(r.id) + '">' + _esc(r.label) + '</option>';
      }).join('') + '</select>' +
      '<div style="margin-top:6px">' +
      '<button class="sga-btn" onclick="SokoniGcpAdmin.grantPlatform()">Add SOKONI role</button>' +
      '</div>' +
      '<p class="sic-note">Applied through the platform’s existing role authority, the same ' +
      'path every other role change uses. There is no second way to mint an admin.</p>' +

      '<div class="sic-sect-l">Google Cloud project role</div>' +
      '<select class="sga-in" id="sgaGcpRole">' +
      '<option value="">— no change —</option>' +
      OFFERED_ROLES.map(function (r) {
        return '<option value="' + _esc(r.id) + '">' + _esc(r.label) + '</option>';
      }).join('') + '</select>' +
      '<div style="margin-top:6px">' +
      '<button class="sga-btn" onclick="SokoniGcpAdmin.grantGcp()">Add Cloud role</button> ' +
      '<button class="sga-btn" onclick="SokoniGcpAdmin.grantGcp(true)">Dry run</button> ' +
      '<button class="sga-btn danger" onclick="SokoniGcpAdmin.revokeGcp()">Revoke Cloud role</button>' +
      '</div>' +

      '<p class="sic-note"><strong>What this will refuse.</strong> Owner, Editor and every ' +
      'IAM-admin role are never grantable here — their holder could grant themselves anything ' +
      'else, which would make every other control decorative. You cannot grant a role to ' +
      'yourself. A role not on the list above is denied by default rather than passed through.</p>' +

      _resultBlock() +
      (_busy ? '<p class="sic-note">Working…</p>' : '') +
      '</div>' + _confirmBlock();
  }

  /* ── Actions ───────────────────────────────────────────────────────── */

  function _field(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }

  function _stage(kind, verb, member, role, extra) {
    if (!member) { _result = { ok: false, message: 'Give a member first.' }; return _render(); }
    if (!role)   { _result = { ok: false, message: 'Choose a role first.' }; return _render(); }
    _confirm = { kind: kind, verb: verb, member: member, role: role, typed: '', extra: extra || null };
    _result = null;
    _render();
  }

  function _finish(ok, message, detail) {
    _busy = false; _confirm = null;
    _result = { ok: ok, message: message, detail: detail || '' };
    _render();
  }

  window.SokoniGcpAdmin = {
    version: '1.0.0',

    mount: function (target, opts) {
      var el = typeof target === 'string' ? document.getElementById(target) : target;
      if (!el) return;
      _root = el;
      _opts = opts || _opts || {};
      _render();
    },

    grantPlatform: function () {
      _stage('platform', 'Grant', _field('sgaMember'), _field('sgaPlatformRole'));
    },
    grantGcp: function (dryRun) {
      _stage('gcp', dryRun ? 'Dry run' : 'Grant', _field('sgaMember'), _field('sgaGcpRole'),
             { dryRun: !!dryRun });
    },
    revokeGcp: function () {
      _stage('gcp-revoke', 'Revoke', _field('sgaMember'), _field('sgaGcpRole'));
    },

    _typed: function (v) { if (_confirm) { _confirm.typed = String(v || '').trim(); _render(); } },
    _cancel: function () { _confirm = null; _render(); },

    _commit: function () {
      if (!_confirm) return;
      /* The typed confirmation is re-checked here, not only in the disabled
         attribute. A disabled button is a hint; this is the check. */
      if (_confirm.typed !== _confirm.member) {
        _result = { ok: false, message: 'The typed member did not match. Nothing was sent.' };
        _confirm = null; return _render();
      }
      var c = _confirm;
      _busy = true; _render();

      var p;
      if (c.kind === 'platform') {
        /* The EXISTING canonical role path. Not a second way to mint an admin. */
        p = _call('setUserRole', { uid: c.member, role: c.role })
          .then(function () {
            return { msg: 'SOKONI role "' + c.role + '" applied to ' + c.member +
                          '. Google Cloud access is unchanged.' };
          });
      } else if (c.kind === 'gcp') {
        p = _call('superAdminGrantGcpRole',
          { member: c.member, role: c.role, dryRun: !!(c.extra && c.extra.dryRun) })
          .then(function (r) {
            if (r && r.dryRun) {
              return { msg: 'Dry run only — nothing was written. ' + (r.reason || '') };
            }
            if (r && r.alreadyGranted) {
              return { msg: 'No change: that member already holds ' + c.role + '.' };
            }
            return { msg: 'Google Cloud role "' + c.role + '" granted to ' + c.member +
                          '. SOKONI access is unchanged.',
                     detail: r && r.etagAfter ? 'policy etag ' + r.etagAfter : '' };
          });
      } else {
        p = _call('superAdminRevokeGcpRole', { member: c.member, role: c.role })
          .then(function (r) {
            if (r && r.changed === false) {
              return { msg: 'No change: that member does not hold ' + c.role + '.' };
            }
            return { msg: 'Google Cloud role "' + c.role + '" revoked from ' + c.member + '.' };
          });
      }

      p.then(function (out) { _finish(true, out.msg, out.detail); })
       .catch(function (e) {
         /* The server's refusal text is shown verbatim. It names WHY, and an
            operator who is refused deserves to know which rule stopped them. */
         _finish(false, (e && e.message) || 'The call failed.', '');
       });
    },

    /* Typing in the member field invalidates a staged confirmation, so a
       confirmation can never be carried over onto a different person. */
    _dirty: function () { if (_confirm) { _confirm = null; _render(); } },

    _state: function () { return { busy: _busy, result: _result, confirm: _confirm }; },
  };
})();
