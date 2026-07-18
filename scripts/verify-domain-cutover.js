#!/usr/bin/env node
/**
 * DNS CUTOVER GATE — mysokoni.co.ke must serve the production application.
 *
 * Blocks the merchant pilot until the apex domain serves Firebase Hosting identically
 * over IPv4 and IPv6, from independent resolvers, with no legacy-origin exposure.
 *
 * Governing rule: observed production behaviour overrides deployment assumptions.
 * A successful DNS change is NOT a pass. Only the wire response is.
 *
 *   node scripts/verify-domain-cutover.js
 *
 * Exit 0 = cutover verified. Exit 1 = still blocked.
 */
'use strict';
const dns = require('dns');
const https = require('https');

const APEX = 'mysokoni.co.ke';
const HOSTS = [APEX, 'www.' + APEX, 'auth.' + APEX];

/* Independent recursive resolvers — a single resolver can serve a stale cache and
   produce a false PASS. This is how the earlier "resolved" call went wrong. */
const RESOLVERS = [
  ['Google',     ['8.8.8.8', '8.8.4.4']],
  ['Cloudflare', ['1.1.1.1', '1.0.0.1']],
  ['Quad9',      ['9.9.9.9']],
  ['OpenDNS',    ['208.67.222.222']],
];

/* Legacy origin that must never answer again. */
const LEGACY_IPS = ['217.20.124.84'];
const LEGACY_SERVERS = /litespeed|apache|nginx\/1\.1[0-9]/i;

let fail = 0;
const PASS = (m) => console.log('  PASS   ' + m);
const FAIL = (m) => { console.log('  FAIL   ' + m); fail++; };
const INFO = (m) => console.log('         ' + m);

const isCloudflare = (ip) => /^(104\.1[6-9]|104\.2[0-7]|172\.6[4-9]|172\.7[0-1]|162\.159|188\.114|198\.41)\./.test(ip);

function resolveWith(servers, host, rrtype) {
  return new Promise((resolve) => {
    const r = new dns.Resolver();
    try { r.setServers(servers); } catch (e) { return resolve({ err: e.message }); }
    r.resolve(host, rrtype, (err, recs) => resolve(err ? { err: err.code || err.message } : { recs }));
  });
}

/* Fetch with the connection PINNED to a specific IP, so we test that path rather than
   whatever the local resolver happens to prefer. */
function fetchPinned(host, ip, family) {
  return new Promise((resolve) => {
    const req = https.request({
      host: ip, servername: host, path: '/', method: 'GET', timeout: 20000,
      family, headers: { Host: host, 'User-Agent': 'SOKONI-cutover-gate' },
    }, (res) => {
      /* Read the certificate NOW — res.socket is null once 'end' has fired. */
      const cert = res.socket && res.socket.getPeerCertificate
        ? res.socket.getPeerCertificate() : null;
      let body = '';
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, cert }));
    });
    req.on('error', (e) => resolve({ err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ err: 'timeout' }); });
    req.end();
  });
}

(async () => {
  console.log('\n  DNS CUTOVER GATE — ' + APEX + '\n');

  /* ── 1. Resolver agreement ── */
  console.log('  [1] Independent resolver agreement');
  const seenA = new Set(), seenAAAA = new Set();
  for (const [name, servers] of RESOLVERS) {
    const a = await resolveWith(servers, APEX, 'A');
    const aaaa = await resolveWith(servers, APEX, 'AAAA');
    const av = a.recs ? a.recs.join(',') : 'ERR:' + a.err;
    const qv = aaaa.recs ? aaaa.recs.join(',') : 'ERR:' + aaaa.err;
    if (a.recs) a.recs.forEach((x) => seenA.add(x));
    if (aaaa.recs) aaaa.recs.forEach((x) => seenAAAA.add(x));
    INFO(name.padEnd(12) + 'A: ' + av.padEnd(34) + 'AAAA: ' + qv);
  }
  if (seenA.size === 0) FAIL('no A record resolved anywhere');
  else PASS('A records observed: ' + [...seenA].join(', '));
  if (seenAAAA.size === 0) FAIL('no AAAA record — IPv6 clients cannot reach the site');
  else PASS('AAAA records observed: ' + [...seenAAAA].join(', '));

  /* ── 2. Legacy origin must be gone ──
     PHASE 1 GATE. DNS no longer pointing at the legacy host is NOT sufficient: while that
     host still answers for this Host header, any client with a stale resolver anywhere in
     the world reaches it and gets its 404. Probe it directly, regardless of DNS. */
  console.log('\n  [2] Legacy origin exposure  (PHASE 1 GATE)');
  const leaked = [...seenA].filter((ip) => LEGACY_IPS.includes(ip));
  if (leaked.length) FAIL('apex still resolves to the legacy host: ' + leaked.join(', '));
  else PASS('no legacy origin IP in DNS');

  for (const ip of LEGACY_IPS) {
    const r = await fetchPinned(APEX, ip, 4);
    if (r.err) { PASS('legacy host ' + ip + ' no longer answers (' + r.err + ')'); continue; }
    const server = r.headers.server || '(none)';
    const loc = r.headers.location || '';
    const redirectsHome = (r.status === 301 || r.status === 308) && /mysokoni\.co\.ke/i.test(loc);
    if (redirectsHome) {
      PASS('legacy host ' + ip + ' returns ' + r.status + ' -> ' + loc + ' (stale clients recover)');
    } else {
      FAIL('legacy host ' + ip + ' STILL SERVING: HTTP ' + r.status + '  server=' + server +
           (loc ? '  -> ' + loc : ''));
      INFO('   Any client with a stale resolver reaches this and sees the wrong site.');
      INFO('   Disable the vhost, or make it 301/308 to https://' + APEX + '/');
    }
  }

  /* www must not be answerable from the legacy host either. */
  for (const ip of LEGACY_IPS) {
    const r = await fetchPinned('www.' + APEX, ip, 4);
    if (r.err) { PASS('legacy host does not answer for www (' + r.err + ')'); continue; }
    const ok = (r.status === 301 || r.status === 308) && /mysokoni\.co\.ke/i.test(r.headers.location || '');
    (ok ? PASS : FAIL)('legacy host for www.' + APEX + ': HTTP ' + r.status +
      (r.headers.location ? ' -> ' + r.headers.location : '  server=' + (r.headers.server || '?')));
  }

  const direct = [...seenA].filter((ip) => !isCloudflare(ip));
  if (direct.length) INFO('note: ' + direct.join(', ') + ' is not a Cloudflare range — confirm this is intended (Firebase A records are valid here)');

  /* ── 2b. IPv6 parity with Firebase ──
     PHASE 2 GATE. Firebase publishes AAAA for its own hosts; a custom domain only has it
     if the AAAA record was actually added. Compare against Firebase's own answer rather
     than assuming a value. */
  console.log('\n  [2b] IPv6 records  (PHASE 2 GATE)');
  const fbAAAA = await resolveWith(RESOLVERS[0][1], 'sokoni-aeb26.web.app', 'AAAA');
  if (fbAAAA.recs && fbAAAA.recs.length) {
    INFO('Firebase publishes AAAA for sokoni-aeb26.web.app: ' + fbAAAA.recs.join(', '));
    if (!seenAAAA.size) {
      FAIL('custom domain has NO AAAA — IPv6-only clients cannot reach the site');
      INFO('   Confirm the expected record in the Firebase Console custom-domain panel,');
      INFO('   then add it for ' + APEX + ' and www.' + APEX + '.');
    } else {
      PASS('custom domain publishes AAAA: ' + [...seenAAAA].join(', '));
    }
  } else {
    INFO('could not read Firebase AAAA — skipping IPv6 comparison');
  }

  /* ── 3. Every resolved IP must serve the app, on both families ──
     A host with no IPv6 stack cannot test IPv6. Reporting that as a site failure would be
     a fabricated finding — the same class of error as measuring a page you never loaded.
     Probe the local stack first and report IPv6 as UNVERIFIED when the fault is ours. */
  let ipv6Local = false;
  {
    const probe = await fetchPinned('cloudflare.com', 'cloudflare.com', 6);
    ipv6Local = !probe.err;
    if (!ipv6Local) INFO('this host has no working IPv6 (control fetch: ' + probe.err + ') — IPv6 checks cannot run here');
  }

  console.log('\n  [3] Wire response per address');
  const bodies = [];
  for (const [ip, fam] of [...[...seenA].map((x) => [x, 4]), ...[...seenAAAA].map((x) => [x, 6])]) {
    if (fam === 6 && !ipv6Local) {
      INFO('IPv6 ' + ip.padEnd(30) + 'UNVERIFIED — no IPv6 on this host, not a site defect');
      continue;
    }
    const r = await fetchPinned(APEX, ip, fam);
    if (r.err) { FAIL('IPv' + fam + ' ' + ip + ' — ' + r.err); continue; }
    const server = r.headers.server || '(none)';
    const legacy = LEGACY_SERVERS.test(server);
    const ok = r.status === 200 && !legacy;
    const title = (r.body.match(/<title>([^<]*)/i) || [, ''])[1].trim().slice(0, 40);
    (ok ? PASS : FAIL)('IPv' + fam + ' ' + ip.padEnd(30) + 'HTTP ' + r.status + '  server=' + server +
      (title ? '  title="' + title + '"' : ''));
    if (legacy) INFO('   ^ LEGACY ORIGIN still answering — cutover incomplete');
    if (ok) bodies.push(title);
  }

  /* ── 4. All tested addresses must serve identical content ── */
  console.log('\n  [4] Content parity across addresses');
  if (new Set(bodies).size === 1 && bodies.length) PASS('all ' + bodies.length + ' tested address(es) served identical content ("' + bodies[0] + '")');
  else if (!bodies.length) FAIL('no address served the application');
  else FAIL('addresses served DIFFERENT content: ' + [...new Set(bodies)].join(' | '));
  if (!ipv6Local) INFO('IPv6 parity UNVERIFIED from this host — must be confirmed from an IPv6-capable network before pilot');

  /* ── 5. SSL ── */
  console.log('\n  [5] TLS certificate');
  const first = [...seenA][0];
  if (first) {
    const r = await fetchPinned(APEX, first, 4);
    if (r.cert && r.cert.subject) {
      const names = (r.cert.subjectaltname || '').replace(/DNS:/g, '');
      const days = Math.round((new Date(r.cert.valid_to) - Date.now()) / 86400000);
      const covers = names.includes(APEX);
      (covers ? PASS : FAIL)('certificate covers ' + APEX + '  [' + names.slice(0, 70) + ']');
      (days > 14 ? PASS : FAIL)('expires in ' + days + ' days (' + r.cert.valid_to + ')');
      INFO('issuer: ' + ((r.cert.issuer && r.cert.issuer.O) || 'unknown'));
    } else FAIL('could not read certificate');
  }

  /* ── 6. Related hosts ── */
  console.log('\n  [6] Related hosts');
  for (const h of HOSTS.slice(1)) {
    const a = await resolveWith(RESOLVERS[0][1], h, 'A');
    if (a.err) { INFO(h.padEnd(26) + 'no A record (' + a.err + ')'); continue; }
    const r = await fetchPinned(h, a.recs[0], 4);
    if (r.err) { FAIL(h + ' — ' + r.err); continue; }
    const loc = r.headers.location ? ' -> ' + r.headers.location : '';
    const legacy = LEGACY_SERVERS.test(r.headers.server || '');
    (legacy ? FAIL : PASS)(h.padEnd(26) + 'HTTP ' + r.status + '  server=' + (r.headers.server || '(none)') + loc);
  }

  console.log('\n  ' + (fail
    ? fail + ' FAILURE(S) — CUTOVER NOT VERIFIED. Pilot remains blocked.'
    : 'CUTOVER VERIFIED over IPv4. ' + APEX + ' serves production.' +
      (ipv6Local ? ' IPv6 verified.' : ' IPv6 UNVERIFIED — re-run from an IPv6-capable network.')) + '\n');
  process.exit(fail ? 1 : 0);
})();
