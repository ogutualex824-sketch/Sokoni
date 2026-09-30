/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   SOKONI PRINT BRIDGE CLIENT — sokoni-print-bridge.js  →  window.SokoniPrintBridge

   The ONE browser-side client for the local SOKONI Print Bridge (tools/sokoni-print-bridge/bridge.js,
   http://127.0.0.1:9101). Every network-printer path — the canonical engine's NetworkAdapter
   (sokoni-universal-printer.js), sokoni-pos-print.js, sokoni-printer-providers.js,
   sokoni-connection-manager.js, sokoni-printer-discovery.js and pos-printer.js — calls THIS, so the
   bridge address, authentication, job ids, retry and the merchant-facing wording exist exactly once.

   It is a TRANSPORT CLIENT, not a print engine: it never builds ESC/POS. It moves bytes a real engine
   built to the bridge, and reports what the bridge answered.

   A job is "printed" only when the bridge answers SENT — every byte flushed to the printer's socket. A
   queued, accepted or merely-requested job is never reported as printed. The old fallback to the cloud
   posPrint function is gone from every caller: a public cloud function is not inside the shop's Wi-Fi,
   so it could never reach the printer.

   Conditions reported (state → what the merchant is told):
     reachable            the bridge is running on this computer
     permission-denied    the browser blocked access to this computer's local network
     not-running          no bridge answered (not installed on this computer, or stopped)
     auth-rejected        the bridge refused this sign-in
     destination-rejected the address is not an allowed shop-network printer (refused before any network)
     printer-unreachable  the bridge could not reach the printer (off, wrong address, other network)
     printer-reachable    the printer answered on its port
     sent                 the printer took the job
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  if (root.SokoniPrintBridge) return;

  /* The bridge is ALWAYS on this computer. A test harness may move it to another loopback port; anything that is
     not http://127.0.0.1:<port> is ignored, so no page setting can point print bytes at another host. */
  var BASE = (function () {
    var o = root.SOKONI_PRINT_BRIDGE_BASE;
    return (typeof o === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o)) ? o : 'http://127.0.0.1:9101';
  }());
  var MESSAGES = {
    'reachable':            'The SOKONI Print Bridge is running on this computer.',
    'permission-denied':    'Your browser blocked SOKONI from this computer\'s local network. Allow "local network access" for mysokoni.co.ke in the site settings, then try again.',
    'not-running':          'The SOKONI Print Bridge is not running on this computer. Install it (POS Setup › Receipt › Wi-Fi printer) or start it, then try again.',
    'auth-rejected':        'The print bridge did not accept this sign-in. Sign in again, then try again.',
    'destination-rejected': 'That address is not a printer on your shop network. Use the printer\'s local IP (for example 192.168.1.50) and port 9100.',
    'printer-unreachable':  'The printer did not answer. Check it is switched on, has paper, and is on the same Wi-Fi as this computer.',
    'printer-reachable':    'The printer answered.',
    'sent':                 'Sent to the printer.',
    'bridge-error':         'The print bridge reported an error. Try again.',
  };
  function messageFor(state) { return MESSAGES[state] || MESSAGES['bridge-error']; }

  function timeout(ms) {
    try { if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms); } catch (_) {}
    return undefined;
  }
  function newJobId(prefix) {
    var r = '';
    try { var a = new Uint32Array(2); root.crypto.getRandomValues(a); r = a[0].toString(36) + a[1].toString(36); }
    catch (_) { r = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
    return String(prefix || 'job').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 24) + '-' + Date.now().toString(36) + '-' + r;
  }
  async function idToken() {
    try {
      var a = root.firebaseAuth || (root.firebase && typeof root.firebase.auth === 'function' ? root.firebase.auth() : null);
      var u = a && a.currentUser;
      return u && typeof u.getIdToken === 'function' ? await u.getIdToken() : null;
    } catch (_) { return null; }
  }
  /* Chrome Local Network Access. The permission name has changed across releases, so every known name is
     tried; an unknown name throws and is skipped. 'unknown' means the browser gave no answer either way. */
  async function lnaPermission() {
    var nav = root.navigator;
    if (!nav || !nav.permissions || typeof nav.permissions.query !== 'function') return 'unknown';
    var names = ['loopback-network', 'local-network-access', 'local-network'];
    for (var i = 0; i < names.length; i++) {
      try { var s = await nav.permissions.query({ name: names[i] }); if (s && s.state) return s.state; } catch (_) {}
    }
    return 'unknown';
  }
  function result(state, extra) {
    var r = { ok: state === 'reachable' || state === 'printer-reachable' || state === 'sent', state: state, message: messageFor(state) };
    if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
    return r;
  }
  function fromHttp(status, body) {
    var code = body && body.code;
    if (status === 401) return result('auth-rejected', { code: code });
    if (status === 400 || status === 413 || status === 421) return result('destination-rejected', { code: code });
    if (status === 502) return result('printer-unreachable', { code: code, retryable: true });
    if (status === 409) return result('bridge-error', { code: code || 'job_in_flight', retryable: true });
    if (status === 429) return result('bridge-error', { code: 'busy', retryable: true });
    return result('bridge-error', { code: code || ('http_' + status), retryable: status >= 500 });
  }
  async function networkFailure() {
    return (await lnaPermission()) === 'denied' ? result('permission-denied') : result('not-running');
  }

  /* Is the bridge on this computer, and may this page reach it? */
  async function status() {
    if ((await lnaPermission()) === 'denied') return result('permission-denied');
    try {
      var r = await root.fetch(BASE + '/ping', { cache: 'no-store', signal: timeout(2500) });
      if (!r.ok) return result('not-running', { code: 'http_' + r.status });
      var j = {}; try { j = await r.json(); } catch (_) {}
      return result('reachable', { version: j.version || null });
    } catch (_) { return networkFailure(); }
  }

  /* Can the bridge reach THIS printer? Nothing is printed. */
  async function probe(host, port) {
    var tok = await idToken();
    if (!tok) return result('auth-rejected', { code: 'signed_out' });
    try {
      var r = await root.fetch(BASE + '/probe?host=' + encodeURIComponent(String(host || '')) + '&port=' + encodeURIComponent(String(port || 9100)),
        { cache: 'no-store', headers: { Authorization: 'Bearer ' + tok }, signal: timeout(8000) });
      var j = {}; try { j = await r.json(); } catch (_) {}
      return r.ok && j.ok ? result('printer-reachable') : fromHttp(r.status, j);
    } catch (_) { return networkFailure(); }
  }

  /* Send ESC/POS bytes. `jobId` is the idempotency key: a retry with the SAME id is answered by the bridge
     from memory and never prints a second copy. One automatic retry for a transient failure, same id. */
  async function print(host, port, bytes, jobId, opts) {
    opts = opts || {};
    var id = jobId || newJobId('print');
    var body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!body.length) return result('bridge-error', { code: 'empty_payload', jobId: id });
    var tok = await idToken();
    if (!tok) return result('auth-rejected', { code: 'signed_out', jobId: id });
    var attempt = async function () {
      try {
        var r = await root.fetch(BASE + '/print', {
          method: 'POST', cache: 'no-store', body: body, signal: timeout(15000),
          headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + tok,
                     'X-Target-Host': String(host || ''), 'X-Target-Port': String(port || 9100), 'X-Job-Id': id },
        });
        var j = {}; try { j = await r.json(); } catch (_) {}
        if (r.ok && j.ok && j.state === 'SENT') return result('sent', { jobId: id, duplicate: !!j.duplicate, bytes: j.bytes });
        var f = fromHttp(r.status, j); f.jobId = id; return f;
      } catch (_) { var n = await networkFailure(); n.jobId = id; return n; }
    };
    var out = await attempt();
    if (!out.ok && out.retryable && opts.retry !== false) {
      await new Promise(function (res) { setTimeout(res, opts.retryDelayMs == null ? 800 : opts.retryDelayMs); });
      out = await attempt();
    }
    return out;
  }

  root.SokoniPrintBridge = { BASE: BASE, status: status, probe: probe, print: print, newJobId: newJobId,
                             messageFor: messageFor, lnaPermission: lnaPermission };
}(typeof window !== 'undefined' ? window : globalThis));
