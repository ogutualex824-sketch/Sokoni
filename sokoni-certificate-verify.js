/* SokoniCertificateVerify — the public certificate check (certificate-verify.html), Education G4 2026-10-03.
   The SERVER answers (courseLessons {op:'verifyCertificate'}); this page renders it, escaped. An unanswered request is
   "could not check right now (—)", never "valid". A revoked certificate stays discoverable as Revoked. */
(function (G) {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var SERIAL = /^SOK-EDU-[0-9A-F]{10}$/;
  var $ = function (id) { return document.getElementById(id); };

  function render(r, serial) {
    var box = $('cvResult'); box.hidden = false;
    if (!r) { box.innerHTML = '<p>Could not check this certificate right now (—). Please try again.</p>'; return; }
    if (!r.found) { box.innerHTML = '<p class="bad">No certificate with the number ' + esc(serial) + ' exists.</p><p class="muted">Check the number for typing mistakes.</p>'; return; }
    var revoked = r.status === 'revoked';
    box.innerHTML = '<p class="' + (revoked ? 'bad' : 'ok') + '">' + (revoked ? 'This certificate was REVOKED' : 'This certificate is genuine and valid') + '</p><dl>'
      + '<dt>Number</dt><dd>' + esc(serial) + '</dd>'
      + '<dt>Holder</dt><dd>' + esc(r.holderInitials || '—') + '</dd>'
      + '<dt>Course</dt><dd>' + esc(r.courseTitle || '—') + '</dd>'
      + '<dt>Provider</dt><dd>' + esc(r.providerName || '—') + '</dd>'
      + '<dt>Issuer</dt><dd>' + esc(r.issuer || 'SOKONI Education') + '</dd>'
      + '<dt>Issued</dt><dd>' + esc(r.issuedAtMs ? new Date(r.issuedAtMs).toISOString().slice(0, 10) : '—') + '</dd>'
      + '<dt>Type</dt><dd>' + esc(r.kind === 'self_paced_completion' ? 'Self-paced course completion' : (r.kind || '—')) + '</dd>'
      + (revoked ? '<dt>Reason</dt><dd>' + esc(r.revokedReason || '—') + '</dd>' : '') + '</dl>';
  }

  function check(serial) {
    serial = String(serial || '').trim().toUpperCase();
    if (!SERIAL.test(serial)) { var b = $('cvResult'); b.hidden = false; b.innerHTML = '<p class="bad">Enter a number like SOK-EDU-1A2B3C4D5E.</p>'; return Promise.resolve(); }
    return G.firebase.functions().httpsCallable('courseLessons')({ op: 'verifyCertificate', serial: serial })
      .then(function (res) { render(res && res.data, serial); }).catch(function () { render(null, serial); });
  }

  function init() {
    var f = $('cvForm'); if (!f) return;
    f.addEventListener('submit', function (e) { e.preventDefault(); check($('cvSerial').value); });
    var q = /[?&]serial=([^&]+)/.exec(String((G.location && G.location.search) || ''));
    if (q) { var v = decodeURIComponent(q[1]); $('cvSerial').value = v; check(v); }
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
  G.SokoniCertificateVerify = { check: check, render: render, init: init };
})(typeof window !== 'undefined' ? window : this);
