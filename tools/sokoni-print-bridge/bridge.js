#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   SOKONI PRINT BRIDGE — the local seam between a SOKONI page and a Wi-Fi / LAN thermal printer.

     SOKONI page (https://mysokoni.co.ke)
        → SokoniPrintBridge client (sokoni-print-bridge.js)
        → THIS bridge on the merchant's own computer, http://127.0.0.1:9101
        → raw TCP to the printer on the shop LAN (ESC/POS, port 9100)

   Why it exists: a browser cannot open a raw TCP socket, and an ordinary ESC/POS network printer speaks
   nothing else. A public cloud function cannot help either — it is not inside the shop's Wi-Fi. The pages
   have called "the SOKONI Desktop bridge on localhost:9101" for a long time; this is that bridge.

   Contract (kept from the existing callers, extended — never a second one):
     GET  /ping, /health                 → 200 {ok, name, version, authRequired}. No auth, no printer detail.
     GET  /probe?host=&port=             → TCP reachability of ONE validated printer. Auth required.
     POST /print                         → body = raw ESC/POS bytes (application/octet-stream, ≤ 64 KB)
                                            headers: X-Target-Host, X-Target-Port, X-Job-Id, Authorization
                                            200 {ok:true,  state:'SENT', jobId, bytes, duplicate?}
                                            4xx {ok:false, state:'REJECTED', code}   (never reaches the network)
                                            502 {ok:false, state:'FAILED', retryable:true, code}
     GET  /scan-printers                 → 501. Sweeping the LAN from a web request is not offered.

   Security (every rule is enforced before any socket is opened):
     · Listens on 127.0.0.1 ONLY — never on a LAN interface.
     · Host header must be 127.0.0.1:<port> or localhost:<port> (defeats DNS rebinding onto the bridge).
     · Origin must be an allowed SOKONI origin; CORS answers only that exact origin. Chrome's Local/Private
       Network Access preflight is answered only for allowed origins.
     · Authorization: a Firebase ID token for the SOKONI project, verified here (RS256 against Google's
       published keys; aud, iss, exp, iat, sub checked). No shared secret exists anywhere in page source.
       Optional allow-list of uids for a till that should print only for its own staff.
     · Destination: an IPv4 literal in 10/8, 172.16/12 or 192.168/16, or a hostname that resolves ONLY to
       such addresses — the connection is made to the validated IP, never re-resolved. Loopback, link-local
       (incl. 169.254.169.254 metadata), multicast, public and IPv6 destinations are refused. No URLs.
     · Port: the raw-print range 9100–9109 only.
     · Idempotency: X-Job-Id is required; a job already SENT in the last 15 minutes is answered from memory
       and NOT printed again; the same id while in flight is refused (409).
     · Bounded: 64 KB per job, 4 concurrent jobs, 120 jobs per minute.

   Run:   node bridge.js                  (Node 18+; no packages to install)
   Env:   SOKONI_BRIDGE_PORT=9101  SOKONI_PROJECT_ID=sokoni-aeb26
          SOKONI_BRIDGE_ORIGINS=https://mysokoni.co.ke,https://sokoni-aeb26.web.app
          SOKONI_BRIDGE_ALLOWED_UIDS=uid1,uid2   (optional)
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const crypto = require('crypto');

const VERSION = '1.0.0';
const DEFAULT_ORIGINS = ['https://mysokoni.co.ke', 'https://sokoni-aeb26.web.app', 'https://sokoni-aeb26.firebaseapp.com'];
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const MAX_BYTES = 64 * 1024;
const PORT_MIN = 9100, PORT_MAX = 9109;
const JOB_TTL_MS = 15 * 60 * 1000;
const MAX_CONCURRENT = 4, MAX_PER_MINUTE = 120;
const CONNECT_TIMEOUT_MS = 4000, WRITE_TIMEOUT_MS = 8000;

/* ── destination validation ─────────────────────────────────────────────────────────────── */
function ipv4Octets(s) {
  if (typeof s !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  const o = s.split('.').map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}
/* PRIVATE LAN only. Everything else — loopback, link-local/metadata, CGNAT, multicast, public — is refused. */
function isAllowedPrinterIp(ip) {
  const o = ipv4Octets(ip);
  if (!o) return false;
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  return false;
}
function validPort(p, opts) {
  const n = Number(p);
  if (opts && opts.allowLoopbackForTests === true && Number.isInteger(n) && n > 1024 && n < 65536) return n;   /* test harness only: fake printers bind random ports */
  return Number.isInteger(n) && n >= PORT_MIN && n <= PORT_MAX ? n : null;
}
/* A hostname is a label list — never a URL, never a userinfo, never a path. */
function validHostname(h) {
  return typeof h === 'string' && h.length <= 253 && /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/i.test(h);
}
async function resolveDestination(host, opts) {
  host = String(host || '').trim();
  if (!host) return { ok: false, code: 'host_required' };
  if (opts && opts.allowLoopbackForTests === true && host === '127.0.0.1') return { ok: true, ip: host };   /* test harness only — never reachable from the CLI */
  if (ipv4Octets(host)) return isAllowedPrinterIp(host) ? { ok: true, ip: host } : { ok: false, code: 'destination_not_private_lan' };
  if (!validHostname(host)) return { ok: false, code: 'invalid_host' };
  let addrs;
  try { addrs = await (opts && opts.lookup ? opts.lookup(host) : dns.promises.lookup(host, { all: true, family: 4 })); }
  catch (_) { return { ok: false, code: 'host_not_found' }; }
  const ips = (addrs || []).map((a) => a.address);
  if (!ips.length) return { ok: false, code: 'host_not_found' };
  /* EVERY answer must be private: one public answer means the name can be steered off the LAN. */
  if (!ips.every(isAllowedPrinterIp)) return { ok: false, code: 'destination_not_private_lan' };
  return { ok: true, ip: ips[0] };                 /* connect to THIS address; the name is not resolved again */
}

/* ── Firebase ID token verification (RS256, Google's published certificates) ─────────────── */
function b64urlJson(s) { return JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
function makeCertsProvider() {
  let cache = null, until = 0;
  return function certs() {
    if (cache && Date.now() < until) return Promise.resolve(cache);
    return new Promise((resolve, reject) => {
      https.get(CERTS_URL, (res) => {
        let body = ''; res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const m = /max-age=(\d+)/.exec(res.headers['cache-control'] || '');
            cache = JSON.parse(body); until = Date.now() + (m ? Number(m[1]) * 1000 : 3600 * 1000);
            resolve(cache);
          } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  };
}
async function verifyIdToken(token, cfg) {
  if (typeof token !== 'string' || token.split('.').length !== 3 || token.length > 4096) return { ok: false, code: 'token_malformed' };
  const [h, p, sig] = token.split('.');
  let header, payload;
  try { header = b64urlJson(h); payload = b64urlJson(p); } catch (_) { return { ok: false, code: 'token_malformed' }; }
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, code: 'token_alg' };
  let certs;
  try { certs = await cfg.certs(); } catch (_) { return { ok: false, code: 'certs_unavailable' }; }
  const pem = certs && certs[header.kid];
  if (!pem) return { ok: false, code: 'token_kid' };
  const v = crypto.createVerify('RSA-SHA256'); v.update(h + '.' + p);
  let good = false;
  try { good = v.verify(pem, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64')); } catch (_) { good = false; }
  if (!good) return { ok: false, code: 'token_signature' };
  const now = Math.floor(cfg.now() / 1000), skew = 300;
  if (payload.aud !== cfg.projectId) return { ok: false, code: 'token_audience' };
  if (payload.iss !== 'https://securetoken.google.com/' + cfg.projectId) return { ok: false, code: 'token_issuer' };
  if (!(Number(payload.exp) > now - skew)) return { ok: false, code: 'token_expired' };
  if (!(Number(payload.iat) <= now + skew)) return { ok: false, code: 'token_iat' };
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) return { ok: false, code: 'token_subject' };
  if (cfg.allowedUids && cfg.allowedUids.length && cfg.allowedUids.indexOf(payload.sub) < 0) return { ok: false, code: 'uid_not_allowed' };
  return { ok: true, uid: payload.sub };
}

/* ── the printer socket ─────────────────────────────────────────────────────────────────── */
function tcpSend(ip, port, bytes, opts) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: ip, port });
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(ct); clearTimeout(wt); try { sock.destroy(); } catch (_) {} resolve(r); };
    const ct = setTimeout(() => finish({ ok: false, code: 'printer_connect_timeout' }), (opts && opts.connectTimeoutMs) || CONNECT_TIMEOUT_MS);
    let wt = null;
    sock.on('connect', () => {
      clearTimeout(ct);
      if (!bytes) return finish({ ok: true });              /* probe: reachability only, nothing written */
      wt = setTimeout(() => finish({ ok: false, code: 'printer_write_timeout' }), (opts && opts.writeTimeoutMs) || WRITE_TIMEOUT_MS);
      sock.end(bytes, () => finish({ ok: true }));          /* callback = all bytes flushed to the printer's socket */
    });
    sock.on('error', (e) => finish({ ok: false, code: 'printer_' + String((e && e.code) || 'error').toLowerCase() }));
  });
}

/* ── the server ─────────────────────────────────────────────────────────────────────────── */
function createBridge(options) {
  const o = options || {};
  const cfg = {
    port: Number(o.port || process.env.SOKONI_BRIDGE_PORT || 9101),
    projectId: o.projectId || process.env.SOKONI_PROJECT_ID || 'sokoni-aeb26',
    origins: o.origins || (process.env.SOKONI_BRIDGE_ORIGINS ? process.env.SOKONI_BRIDGE_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS),
    allowedUids: o.allowedUids || (process.env.SOKONI_BRIDGE_ALLOWED_UIDS ? process.env.SOKONI_BRIDGE_ALLOWED_UIDS.split(',').map((s) => s.trim()).filter(Boolean) : []),
    certs: o.certs || makeCertsProvider(),
    now: o.now || (() => Date.now()),
    allowLoopbackForTests: o.allowLoopbackForTests === true,
    lookup: o.lookup || null,
    sendImpl: typeof o.sendImpl === 'function' ? o.sendImpl : tcpSend,   /* module API only (tests); the CLI always uses tcpSend */
    connectTimeoutMs: o.connectTimeoutMs, writeTimeoutMs: o.writeTimeoutMs,
    log: o.log || ((m) => console.log(new Date().toISOString() + ' ' + m)),
  };
  const jobs = new Map();                            /* jobId → { state, at, bytes } */
  let inFlight = 0, window0 = 0, windowCount = 0;

  function allowedHostHeader(h) { return h === '127.0.0.1:' + cfg.port || h === 'localhost:' + cfg.port; }
  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && cfg.origins.indexOf(origin) >= 0) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      return true;
    }
    return false;
  }
  function send(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function sweep() { const t = cfg.now(); for (const [k, v] of jobs) if (t - v.at > JOB_TTL_MS) jobs.delete(k); }

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHostHeader(req.headers.host)) return send(res, 421, { ok: false, state: 'REJECTED', code: 'bad_host_header' });
      const url = new URL(req.url, 'http://127.0.0.1:' + cfg.port);
      const originOk = cors(req, res);

      if (req.method === 'OPTIONS') {
        if (!originOk) return send(res, 403, { ok: false, state: 'REJECTED', code: 'origin_not_allowed' });
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Target-Host, X-Target-Port, X-Job-Id');
        res.setHeader('Access-Control-Max-Age', '600');
        /* Chrome Local/Private Network Access preflight: answered ONLY for an allowed origin. */
        if (req.headers['access-control-request-private-network'] === 'true' || req.headers['access-control-request-local-network'] === 'true') {
          res.setHeader('Access-Control-Allow-Private-Network', 'true');
          res.setHeader('Access-Control-Allow-Local-Network', 'true');
        }
        res.writeHead(204); return res.end();
      }

      if (req.method === 'GET' && (url.pathname === '/ping' || url.pathname === '/health')) {
        /* Liveness only: no printers, no jobs, no identity. Any origin may learn that a bridge answers. */
        return send(res, 200, { ok: true, name: 'SOKONI Print Bridge', version: VERSION, authRequired: true });
      }
      if (url.pathname === '/scan-printers') return send(res, 501, { ok: false, state: 'REJECTED', code: 'scan_not_offered' });

      if (!originOk) return send(res, 403, { ok: false, state: 'REJECTED', code: 'origin_not_allowed' });
      const auth = String(req.headers.authorization || '');
      const v = await verifyIdToken(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '', cfg);
      if (!v.ok) return send(res, 401, { ok: false, state: 'REJECTED', code: v.code });

      if (req.method === 'GET' && url.pathname === '/probe') {
        const port = validPort(url.searchParams.get('port') || 9100, cfg);
        if (!port) return send(res, 400, { ok: false, state: 'REJECTED', code: 'port_not_allowed' });
        const d = await resolveDestination(url.searchParams.get('host'), cfg);
        if (!d.ok) return send(res, 400, { ok: false, state: 'REJECTED', code: d.code });
        const r = await tcpSend(d.ip, port, null, cfg);
        return send(res, r.ok ? 200 : 502, r.ok ? { ok: true, state: 'REACHABLE' } : { ok: false, state: 'FAILED', retryable: true, code: r.code });
      }

      if (req.method === 'POST' && url.pathname === '/print') {
        const jobId = String(req.headers['x-job-id'] || '');
        if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(jobId)) return send(res, 400, { ok: false, state: 'REJECTED', code: 'job_id_required' });
        const port = validPort(req.headers['x-target-port'] || 9100, cfg);
        if (!port) return send(res, 400, { ok: false, state: 'REJECTED', code: 'port_not_allowed' });
        const d = await resolveDestination(req.headers['x-target-host'], cfg);
        if (!d.ok) return send(res, 400, { ok: false, state: 'REJECTED', code: d.code });

        sweep();
        const prev = jobs.get(jobId);
        if (prev && prev.state === 'SENT') return send(res, 200, { ok: true, state: 'SENT', jobId, bytes: prev.bytes, duplicate: true });
        if (prev && prev.state === 'SENDING') return send(res, 409, { ok: false, state: 'ACCEPTED', code: 'job_in_flight', jobId });

        const t = cfg.now();
        if (t - window0 > 60000) { window0 = t; windowCount = 0; }
        if (inFlight >= MAX_CONCURRENT || windowCount >= MAX_PER_MINUTE) return send(res, 429, { ok: false, state: 'RETRYABLE', retryable: true, code: 'busy' });

        const chunks = []; let size = 0, tooBig = false;
        await new Promise((resolve) => {
          req.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { tooBig = true; } else chunks.push(c); });
          req.on('end', resolve); req.on('error', resolve);
        });
        if (tooBig) return send(res, 413, { ok: false, state: 'REJECTED', code: 'payload_too_large' });
        const bytes = Buffer.concat(chunks);
        if (!bytes.length) return send(res, 400, { ok: false, state: 'REJECTED', code: 'empty_payload' });

        jobs.set(jobId, { state: 'SENDING', at: t, bytes: bytes.length });
        inFlight++; windowCount++;
        const r = await cfg.sendImpl(d.ip, port, bytes, cfg);
        inFlight--;
        if (r.ok) {
          jobs.set(jobId, { state: 'SENT', at: cfg.now(), bytes: bytes.length });
          cfg.log('SENT job=' + jobId + ' to=' + d.ip + ':' + port + ' bytes=' + bytes.length + ' uid=' + v.uid.slice(0, 6) + '…');
          return send(res, 200, { ok: true, state: 'SENT', jobId, bytes: bytes.length });
        }
        jobs.delete(jobId);                           /* a failed job may be retried with the SAME id */
        cfg.log('FAILED job=' + jobId + ' to=' + d.ip + ':' + port + ' code=' + r.code);
        return send(res, 502, { ok: false, state: 'FAILED', retryable: true, code: r.code, jobId });
      }
      return send(res, 404, { ok: false, state: 'REJECTED', code: 'not_found' });
    } catch (e) {
      return send(res, 500, { ok: false, state: 'FAILED', retryable: true, code: 'bridge_error' });
    }
  });
  return { server, cfg, listen: (cb) => server.listen(cfg.port, '127.0.0.1', cb), close: (cb) => server.close(cb) };
}

module.exports = { createBridge, verifyIdToken, resolveDestination, isAllowedPrinterIp, validPort, VERSION };

if (require.main === module) {
  const b = createBridge();
  b.listen(() => b.cfg.log('SOKONI Print Bridge ' + VERSION + ' on http://127.0.0.1:' + b.cfg.port + ' for ' + b.cfg.origins.join(', ')));
}
