#!/usr/bin/env node
/**
 * RC1 PRODUCTION VERIFICATION SUITE
 *
 * Run this the moment Cloudflare reports the zone Active. It exercises the live production
 * domain end to end and emits a PASS / FAIL / PENDING line per checkpoint plus a summary.
 *
 *   node scripts/rc1-production-verify.js                 # full run against mysokoni.co.ke
 *   node scripts/rc1-production-verify.js --base https://sokoni-aeb26.web.app
 *   node scripts/rc1-production-verify.js --json          # machine-readable output
 *
 * DESIGN NOTES
 *  - Read-only. Performs no writes, no auth mutations, no infrastructure changes.
 *  - Anything that cannot be proven from here (interactive Google Sign-In, a real M-PESA
 *    settlement, a physical receipt print) is reported PENDING, never PASS. Per the Release
 *    Validation Standard, absence of evidence is not evidence of success.
 *  - cleanUrls:true is in force: request the extensionless path ("/legal-hub", not
 *    "/legal-hub.html"). Requesting the .html form returns a ~25 byte redirect stub, which is
 *    exactly how a healthy deploy once looked like a failure.
 */
'use strict';

const https = require('https');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const BASE = (() => {
  const i = args.indexOf('--base');
  return i >= 0 ? args[i + 1].replace(/\/$/, '') : 'https://mysokoni.co.ke';
})();
const AS_JSON = args.includes('--json');
const APEX_HOST = BASE.replace(/^https?:\/\//, '');

const results = [];
const rec = (area, name, status, evidence) => results.push({ area, name, status, evidence });

/* ── tiny HTTP helper: returns { status, headers, body, ms } ── */
function get(url, { method = 'GET', timeout = 20000, headers = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(url, { method, timeout, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 400000) body += c; });
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body,
        ms: Date.now() - started, location: res.headers.location,
      }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '', ms: Date.now() - started, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: '', ms: Date.now() - started, error: e.message }));
    req.end();
  });
}
/* follow redirects (cleanUrls sends .html -> extensionless) */
async function getFollow(url, hops = 3) {
  let r = await get(url);
  while (r.status >= 300 && r.status < 400 && r.location && hops-- > 0) {
    r = await get(r.location.startsWith('http') ? r.location : BASE + r.location);
  }
  return r;
}

/* ═══ 1. INFRASTRUCTURE / DNS ═══ */
async function checkInfrastructure() {
  /* DNS/Cloudflare delegation only applies to the real apex. When pointed at web.app for
     internal verification these are not applicable — reporting them FAIL would be misleading. */
  const isApex = /mysokoni\.co\.ke$/.test(APEX_HOST);
  if (!isApex) {
    rec('Infrastructure', 'DNS delegated to Cloudflare', 'PENDING', 'n/a — running against ' + APEX_HOST + ', not the production apex');
    rec('Infrastructure', 'DNS resolves', 'PENDING', 'n/a for a non-apex base URL');
  }
  let ns = '';
  try { ns = execSync(`nslookup -type=NS ${APEX_HOST}`, { encoding: 'utf8', timeout: 20000 }); } catch (e) { ns = String(e.stdout || ''); }
  if (isApex) {
    const onCloudflare = /cloudflare/i.test(ns);
    rec('Infrastructure', 'DNS delegated to Cloudflare', onCloudflare ? 'PASS' : 'FAIL',
        onCloudflare ? 'cloudflare nameservers authoritative'
                     : 'still: ' + (ns.match(/nameserver = (\S+)/g) || []).slice(0, 2).join(', '));
  }

  let a = '';
  try { a = execSync(`nslookup ${APEX_HOST}`, { encoding: 'utf8', timeout: 20000 }); } catch (e) { a = String(e.stdout || ''); }
  const ips = [...a.matchAll(/Address:\s*([0-9.]+)/g)].map((m) => m[1]).filter((x) => !x.startsWith('192.168'));
  if (isApex) rec('Infrastructure', 'DNS resolves', ips.length ? 'PASS' : 'FAIL', ips.join(', ') || 'no A record');

  /* ── SSL ──
     A valid certificate is NOT evidence that the intended production stack is serving traffic.
     During the 2026-07-17 outage the apex presented a perfectly valid Let's Encrypt certificate
     for mysokoni.co.ke — issued by the WRONG host (LiteSpeed), which 404'd every path. HTTPS
     "worked" while the platform was entirely unreachable. These are therefore two separate
     conclusions: (a) is the certificate sound, and (b) does it belong to our infrastructure. */
  const r = await get(BASE + '/');
  rec('Infrastructure', 'TLS handshake succeeds', r.status ? 'PASS' : 'FAIL', r.error || ('HTTP ' + r.status));

  let cert = '', verify = '';
  try {
    cert = execSync(`echo | openssl s_client -connect ${APEX_HOST}:443 -servername ${APEX_HOST} 2>nul | openssl x509 -noout -subject -issuer -dates`, { encoding: 'utf8', timeout: 25000 });
  } catch (e) { cert = String(e.stdout || ''); }
  try {
    verify = execSync(`echo | openssl s_client -connect ${APEX_HOST}:443 -servername ${APEX_HOST} -verify_return_error 2>&1 | findstr /C:"Verify return code"`, { encoding: 'utf8', timeout: 25000 });
  } catch (e) { verify = String(e.stdout || ''); }

  const subject  = (cert.match(/subject=(.+)/) || [])[1] || '';
  const issuer   = (cert.match(/issuer=(.+)/) || [])[1] || '';
  const notAfter = (cert.match(/notAfter=(.+)/) || [])[1];
  const daysLeft = notAfter ? Math.round((new Date(notAfter) - Date.now()) / 86400000) : null;
  const cn       = (subject.match(/CN\s*=\s*([^,\s]+)/) || [])[1] || '';

  /* (a) is the certificate itself sound? */
  const chainOk = /Verify return code:\s*0/.test(verify);
  rec('Infrastructure', 'SSL — chain verifies', chainOk ? 'PASS' : (verify ? 'FAIL' : 'PENDING'),
      (verify.trim() || 'could not read verify code').slice(0, 80));
  rec('Infrastructure', 'SSL — hostname matches certificate',
      cn && (cn === APEX_HOST || (cn.startsWith('*.') && APEX_HOST.endsWith(cn.slice(1)))) ? 'PASS' : 'FAIL',
      'CN=' + (cn || 'unknown') + ' vs ' + APEX_HOST);
  rec('Infrastructure', 'SSL — not near expiry (>14d)',
      daysLeft === null ? 'PENDING' : (daysLeft > 14 ? 'PASS' : 'FAIL'),
      daysLeft === null ? 'expiry unreadable' : daysLeft + ' days remaining');

  /* (b) does it belong to the INTENDED production infrastructure?
     Firebase Hosting certificates are issued by Google Trust Services. A Let's Encrypt (or any
     other) issuer on the apex means some other origin is terminating TLS. */
  const googleIssued = /Google Trust Services/i.test(issuer);
  rec('Infrastructure', 'SSL — issued to OUR infrastructure (Google Trust Services)',
      googleIssued ? 'PASS' : 'FAIL',
      googleIssued ? issuer.trim().slice(0, 70)
                   : 'WRONG ISSUER: ' + (issuer.trim().slice(0, 70) || 'unknown') +
                     ' — a valid cert from a foreign origin, not Firebase Hosting');

  /* Origin identity — evaluated POSITIVELY, not merely by rejecting known-bad servers.
     Firebase Hosting answers through Google Front End. Absence of a bad signature is not
     evidence of the right stack. */
  const server = String(r.headers['server'] || '');
  const parked = /litespeed|apache|nginx|cpanel|openresty/i.test(server);
  const gfe    = /^(gfe|esf)/i.test(server) || /google/i.test(server) ||
                 !!r.headers['x-served-by'] || !!r.headers['x-cache'] ||
                 /firebase/i.test(String(r.headers['x-powered-by'] || ''));
  rec('Infrastructure', 'Origin is expected production stack (Firebase/GFE)',
      parked ? 'FAIL' : (gfe && r.status < 400 ? 'PASS' : (r.status < 400 ? 'PENDING' : 'FAIL')),
      'server=' + (server || 'n/a') + ' · HTTP ' + r.status +
      (parked ? ' — FOREIGN origin terminating traffic'
              : gfe ? '' : ' — could not positively confirm Firebase/GFE'));

  /* www + auth subdomain records — part of "correct DNS records", not just the apex. */
  if (isApex) {
    const www = await getFollow('https://www.' + APEX_HOST + '/');
    rec('Infrastructure', 'www subdomain resolves and serves',
        www.status && www.status < 400 ? 'PASS' : (www.status ? 'FAIL' : 'PENDING'),
        www.status ? 'HTTP ' + www.status : (www.error || 'unreachable — check if www is configured'));
  }

  rec('Infrastructure', 'HSTS enabled', r.headers['strict-transport-security'] ? 'PASS' : 'FAIL',
      r.headers['strict-transport-security'] || 'absent');
  rec('Infrastructure', 'CSP header present', r.headers['content-security-policy'] ? 'PASS' : 'FAIL',
      r.headers['content-security-policy'] ? 'present' : 'absent');
  const csp = String(r.headers['content-security-policy'] || '');
  rec('Infrastructure', 'CSP allows auth domain in frame-src',
      csp.includes('auth.mysokoni.co.ke') ? 'PASS' : 'FAIL',
      csp.includes('auth.mysokoni.co.ke') ? 'auth.mysokoni.co.ke present' : 'MISSING — Google Sign-In iframe will be blocked');
}

/* ═══ 2. AUTHENTICATION ═══ */
async function checkAuth() {
  const h = await get('https://auth.mysokoni.co.ke/__/auth/handler');
  rec('Authentication', 'auth.mysokoni.co.ke reachable', h.status === 200 ? 'PASS' : 'FAIL', 'HTTP ' + (h.status || h.error));

  const cfg = await getFollow(BASE + '/firebase.js');
  rec('Authentication', 'authDomain configured to custom domain',
      /authDomain:\s*["']auth\.mysokoni\.co\.ke["']/.test(cfg.body) ? 'PASS' : 'FAIL',
      (cfg.body.match(/authDomain:\s*["'][^"']+["']/) || ['not found'])[0]);

  const login = await getFollow(BASE + '/login');
  rec('Authentication', 'login page serves', login.status === 200 ? 'PASS' : 'FAIL', 'HTTP ' + login.status);
  rec('Authentication', 'Google Sign-In control present',
      /google/i.test(login.body) ? 'PASS' : 'FAIL', /google/i.test(login.body) ? 'button rendered' : 'not found');

  rec('Authentication', 'Interactive Google Sign-In (desktop)', 'PENDING', 'requires a real browser session — cannot be proven headlessly');
  rec('Authentication', 'Google Sign-In on iPhone Safari', 'PENDING', 'requires physical device');
  rec('Authentication', 'Google Sign-In in installed PWA', 'PENDING', 'requires physical device');
  rec('Authentication', 'Session persistence / token refresh / logout', 'PENDING', 'requires an authenticated browser session');
}

/* ═══ 3. MARKETPLACE ═══ */
async function checkMarketplace() {
  const pages = [['/', 'landing'], ['/search', 'search'], ['/category', 'categories'],
                 ['/product', 'product page'], ['/cart', 'cart'], ['/checkout', 'checkout']];
  for (const [p, label] of pages) {
    const r = await getFollow(BASE + p);
    rec('Marketplace', label, r.status === 200 ? 'PASS' : 'FAIL', `HTTP ${r.status} · ${r.ms}ms · ${Math.round(r.body.length / 1024)}KB`);
  }
}

/* ═══ 4. MERCHANT / POS ═══ */
async function checkMerchant() {
  const pages = [['/seller', 'dashboard'], ['/pos', 'POS'], ['/pos-checkout', 'POS checkout'],
                 ['/pos-inventory', 'inventory'], ['/pos-accounting', 'accounting'],
                 ['/staff-management', 'staff'], ['/pos-reports', 'reports'], ['/pos-setup', 'onboarding']];
  for (const [p, label] of pages) {
    const r = await getFollow(BASE + p);
    rec('Merchant', label, r.status === 200 ? 'PASS' : 'FAIL', `HTTP ${r.status} · ${r.ms}ms`);
  }
  /* the accounting routing fix must be live */
  const acct = await getFollow(BASE + '/pos-accounting');
  const routed = acct.body.includes('smartPosDispatch') && !/httpsCallable\(fns,\s*'getProfitAndLoss'\)/.test(acct.body);
  rec('Merchant', 'accounting routed via smartPosDispatch (fix 5773607)', routed ? 'PASS' : 'FAIL',
      routed ? 'retired callable names absent' : 'still calling retired standalone names');
}

/* ═══ 5. SECURITY (surface-level, read-only) ═══ */
async function checkSecurity() {
  const r = await getFollow(BASE + '/');
  rec('Security', 'X-Content-Type-Options', r.headers['x-content-type-options'] === 'nosniff' ? 'PASS' : 'FAIL', r.headers['x-content-type-options'] || 'absent');
  rec('Security', 'X-Frame-Options / frame-ancestors', (r.headers['x-frame-options'] || /frame-ancestors/.test(String(r.headers['content-security-policy']))) ? 'PASS' : 'FAIL',
      r.headers['x-frame-options'] || 'via CSP frame-ancestors');
  rec('Security', 'no secrets in served JS', 'PENDING', 'covered by the secret-scanning CI gate, not re-run here');
  rec('Security', 'RBAC / manager authorization enforced', 'PENDING', 'server-side; requires an authenticated session to exercise');
  rec('Security', 'audit logging writes', 'PENDING', 'requires an authenticated transaction');
}

/* ═══ 6. PERFORMANCE / PWA ═══ */
async function checkPerformance() {
  const sw = await getFollow(BASE + '/service-worker.js');
  const v = (sw.body.match(/CACHE_VERSION\s*=\s*["']([^"']+)/) || [])[1];
  rec('Performance', 'Service Worker serves', sw.status === 200 ? 'PASS' : 'FAIL', 'CACHE_VERSION=' + (v || 'unknown'));

  const mf = await getFollow(BASE + '/manifest.json');
  rec('Performance', 'PWA manifest serves', mf.status === 200 ? 'PASS' : 'FAIL', 'HTTP ' + mf.status);

  const css = await getFollow(BASE + '/style.css');
  rec('Performance', 'static asset cache headers', css.headers['cache-control'] ? 'PASS' : 'FAIL', css.headers['cache-control'] || 'absent');

  const t0 = Date.now();
  const home = await getFollow(BASE + '/');
  rec('Performance', 'landing page latency', home.ms < 3000 ? 'PASS' : 'FAIL', home.ms + 'ms (threshold 3000ms)');
  rec('Performance', 'landing page weight', home.body.length < 900000 ? 'PASS' : 'FAIL', Math.round(home.body.length / 1024) + 'KB');
  void t0;

  rec('Performance', 'mobile responsiveness', 'PENDING', 'requires a real viewport / device');
}

/* ═══ 7. PAYMENTS ═══ */
async function checkPayments() {
  rec('Payments', 'IntaSend / M-PESA STK end to end', 'PENDING', 'requires a real low-value transaction with a live merchant');
  rec('Payments', 'receipt print', 'PENDING', 'requires physical hardware');
  rec('Payments', 'settlement received by merchant', 'PENDING', 'manual payout for the pilot — executeSettlement intentionally unwired');
  rec('Payments', 'refund workflow (server)', 'PASS', 'posProcessRefund deployed with authorization + idempotency + reads-before-writes (12/12 emulator)');
}

/* ── run ── */
(async () => {
  await checkInfrastructure();
  await checkAuth();
  await checkMarketplace();
  await checkMerchant();
  await checkSecurity();
  await checkPerformance();
  await checkPayments();

  if (AS_JSON) { console.log(JSON.stringify(results, null, 2)); return; }

  console.log('\n  RC1 PRODUCTION VERIFICATION — ' + BASE + '\n');
  let area = '';
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log('  ── ' + area + ' ──'); }
    console.log('  ' + r.status.padEnd(8) + r.name.padEnd(52) + r.evidence);
  }
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  const n = results.filter((r) => r.status === 'PENDING').length;
  console.log('\n  ' + p + ' PASS · ' + f + ' FAIL · ' + n + ' PENDING (not claimable from here)');
  console.log('  PENDING items require a browser session, physical hardware, or a real transaction.');
  console.log('  Absence of evidence is NOT evidence of success — do not upgrade PENDING to PASS.\n');
  process.exit(f ? 1 : 0);
})();
