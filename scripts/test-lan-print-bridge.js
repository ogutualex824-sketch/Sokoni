/* test-lan-print-bridge.js — Wi-Fi / LAN thermal printing end-to-end, up to the printer's socket.
 *
 *   node scripts/test-lan-print-bridge.js          (no browser, no LAN, no network egress)
 *
 * 2026-10-01 owner execution order "END-TO-END NETWORK PRINTER + TILL PRINTING REPAIR".
 * Runs the REAL bridge (tools/sokoni-print-bridge/bridge.js) on a loopback port, a fake ESC/POS printer (a TCP
 * server that records every byte), the REAL browser client (sokoni-print-bridge.js) in a vm, and the REAL canonical
 * engine's NetworkAdapter. Tokens are RS256-signed with a key generated here; the bridge verifies them exactly as
 * it verifies Firebase ID tokens (aud / iss / exp / iat / sub / kid).
 *
 * The one test-only allowance: the bridge instance that talks to the fake printer is created with
 * allowLoopbackForTests (the fake printer lives on 127.0.0.1). That option exists only in the module API; the
 * command-line bridge never sets it, and section D runs a STRICT instance that refuses 127.0.0.1.
 *
 * Physical proof (paper out of a real printer) is NOT claimed here — see docs/LAN_PRINTING.md §6.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), net = require('net'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const { createBridge, isAllowedPrinterIp, resolveDestination } = require(path.join(ROOT, 'tools', 'sokoni-print-bridge', 'bridge.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (!ok && d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(70));
const ORIGIN = 'https://mysokoni.co.ke', PROJECT = 'sokoni-aeb26';

/* ── signing ── */
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
function token(over, hdr) {
  const now = Math.floor(Date.now() / 1000);
  const h = Object.assign({ alg: 'RS256', kid: 'k1', typ: 'JWT' }, hdr || {});
  const p = Object.assign({ aud: PROJECT, iss: 'https://securetoken.google.com/' + PROJECT, sub: 'merchant-uid-1', iat: now - 10, exp: now + 3600 }, over || {});
  const si = b64u(h) + '.' + b64u(p);
  const sig = crypto.createSign('RSA-SHA256').update(si).sign(privateKey).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return si + '.' + sig;
}
const certs = () => Promise.resolve({ k1: PUB });

/* Wait until the fake printer has recorded n receipts (not a fixed sleep — the socket close races the ack). */
async function waitGot(p, n, ms) { const t0 = Date.now(); while (p.got.length < n && Date.now() - t0 < (ms || 3000)) await new Promise((r) => setTimeout(r, 20)); }
function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function fakePrinter(opts) {
  const got = []; let conns = 0;
  const srv = net.createServer((sock) => {
    conns++; const chunks = [];
    if (opts && opts.pauseMs) { sock.pause(); setTimeout(() => sock.resume(), opts.pauseMs); }
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => { const b = Buffer.concat(chunks); if (b.length) got.push(b); if (opts && opts.slowMs) setTimeout(() => sock.end(), opts.slowMs); else sock.end(); });
    sock.on('error', () => {});
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port, got, conns: () => conns })));
}
async function req(port, p, o) {
  o = o || {};
  const headers = Object.assign({ Origin: ORIGIN }, o.headers || {});
  const r = await fetch('http://127.0.0.1:' + port + p, { method: o.method || 'GET', headers, body: o.body });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j, headers: r.headers };
}

(async () => {
console.log('\nLAN PRINTING — SOKONI Print Bridge end-to-end (to the printer socket)');
console.log('='.repeat(70));

const printer = await fakePrinter();
const BP = await freePort();
const bridge = createBridge({ port: BP, origins: [ORIGIN], projectId: PROJECT, certs, allowLoopbackForTests: true, log: () => {}, connectTimeoutMs: 1500 });
await new Promise((r) => bridge.listen(r));
const SP = await freePort();
const strict = createBridge({ port: SP, origins: [ORIGIN], projectId: PROJECT, certs, log: () => {} });
await new Promise((r) => strict.listen(r));
const closedPort = await freePort();          /* nothing listens here: an unreachable "printer" in the allowed range is simulated below */

/* ── the REAL browser client in a vm, pointed at the test bridge ── */
function clientCtx(opts) {
  opts = opts || {};
  const ctx = {
    SOKONI_PRINT_BRIDGE_BASE: 'http://127.0.0.1:' + (opts.port || BP),
    fetch: (u, o) => { o = Object.assign({}, o || {}); o.headers = Object.assign({ Origin: ORIGIN }, o.headers || {}); return fetch(u, o); },
    navigator: opts.navigator || {}, crypto: crypto.webcrypto, AbortSignal, setTimeout, Uint8Array, Uint32Array, Date, Math, JSON, Promise, encodeURIComponent, String, Number, Object,
    firebaseAuth: opts.signedOut ? { currentUser: null } : { currentUser: { getIdToken: () => Promise.resolve(opts.token || token()) } },
  };
  ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(read('sokoni-print-bridge.js'), ctx);
  return ctx.SokoniPrintBridge;
}
const B = clientCtx();

/* ── A. bridge unavailable ── */
head('A — bridge unavailable');
const Bnone = clientCtx({ port: closedPort });
let r = await Bnone.status();
ck('no bridge answering → state not-running with an actionable message', r.ok === false && r.state === 'not-running' && /not running on this computer/.test(r.message), r);
r = await Bnone.print('127.0.0.1', printer.port, new Uint8Array([1, 2]), 'job-A-000001', { retryDelayMs: 0 });
ck('printing with no bridge → not-running, never "sent"', r.ok === false && r.state === 'not-running', r);
ck('the override accepts ONLY http://127.0.0.1:<port> (a page cannot point print bytes elsewhere)', (() => {
  const c = { SOKONI_PRINT_BRIDGE_BASE: 'http://evil.example:9101', fetch: () => {}, navigator: {} }; c.window = c; vm.createContext(c); vm.runInContext(read('sokoni-print-bridge.js'), c); return c.SokoniPrintBridge.BASE === 'http://127.0.0.1:9101'; })());

/* ── B. bridge up, printer unreachable ── */
head('B — bridge up, printer unreachable');
r = await B.print('127.0.0.1', closedPort, new Uint8Array([27, 64]), 'job-B-000001', { retryDelayMs: 0 });
ck('printer not answering → printer-unreachable, retryable (FAILED at the bridge)', r.ok === false && r.state === 'printer-unreachable' && r.retryable === true, r);
r = await B.probe('127.0.0.1', closedPort);
ck('Test connection to a dead printer → printer-unreachable', r.ok === false && r.state === 'printer-unreachable', r);

/* ── C. bridge up, printer reachable ── */
head('C — bridge up, printer reachable');
r = await B.status();
ck('status → reachable, with the bridge version', r.ok === true && r.state === 'reachable' && r.version === '1.0.0', r);
r = await B.probe('127.0.0.1', printer.port);
ck('Test connection → printer-reachable, and NOTHING is printed by a probe', r.ok === true && r.state === 'printer-reachable' && printer.got.length === 0, { r, got: printer.got.length });
const RECEIPT = Buffer.from([0x1b, 0x40, 0x1b, 0x61, 0x01, ...Buffer.from('SOKONI TEST\n'), 0x1d, 0x56, 0x00]);
r = await B.print('127.0.0.1', printer.port, new Uint8Array(RECEIPT), 'job-C-000001');
await waitGot(printer, 1);
ck('print → sent, acknowledged by the bridge', r.ok === true && r.state === 'sent' && r.bytes === RECEIPT.length, r);
ck('the printer received EXACTLY the ESC/POS bytes', printer.got.length === 1 && Buffer.compare(printer.got[0], RECEIPT) === 0, printer.got.map((g) => g.length));

/* An HTTP 200 is not proof: a foreign or older service on the port that only ACCEPTS (queues) is never 'sent'. */
{
  const http = require('http');
  const QP = await freePort();
  const q = http.createServer((rq, rs) => { rs.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ORIGIN }); rs.end(JSON.stringify(rq.url === '/ping' ? { ok: true } : { ok: true, state: 'ACCEPTED', queued: true })); });
  await new Promise((res) => q.listen(QP, '127.0.0.1', res));
  const Bq = clientCtx({ port: QP });
  const rq = await Bq.print('192.168.1.50', 9100, new Uint8Array([1]), 'job-C-queued-01', { retry: false });
  ck('a 200 that only says ACCEPTED/queued is NOT reported as sent', rq.ok === false && rq.state !== 'sent', rq);
  q.close();
}

/* ── D. invalid destinations — refused before any socket ── */
head('D — invalid destinations are refused before the network');
const Bs = clientCtx({ port: SP });
const before = printer.conns();
for (const [host, port, why] of [['127.0.0.1', printer.port, 'loopback'], ['8.8.8.8', 9100, 'public internet'], ['169.254.169.254', 9100, 'cloud metadata'],
                                  ['0.0.0.0', 9100, 'unspecified'], ['224.0.0.1', 9100, 'multicast'], ['http://192.168.1.5', 9100, 'a URL'],
                                  ['192.168.1.5', 22, 'port outside 9100-9109'], ['::1', 9100, 'IPv6 loopback']]) {
  r = await Bs.print(host, port, new Uint8Array([1]), 'job-D-' + why.replace(/\W/g, '').slice(0, 20) + '-01', { retryDelayMs: 0 });
  ck('refused: ' + why + ' (' + host + ':' + port + ')', r.ok === false && r.state === 'destination-rejected', r);
}
ck('the strict bridge opened NO connection for any refused destination', printer.conns() === before, { before, after: printer.conns() });
ck('a hostname resolving to a PUBLIC address is refused (DNS cannot steer a job off the LAN)',
   (await resolveDestination('printer.local', { lookup: async () => [{ address: '192.168.1.9' }, { address: '52.1.2.3' }] })).code === 'destination_not_private_lan');
ck('a hostname resolving only to the LAN is accepted and pinned to that IP',
   (await resolveDestination('printer.local', { lookup: async () => [{ address: '192.168.1.9' }] })).ip === '192.168.1.9');
ck('private ranges exactly: 10/8, 172.16/12, 192.168/16 in; 172.32 and 100.64 (CGNAT) out',
   ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1'].every(isAllowedPrinterIp) && !['172.32.0.1', '100.64.0.1', '192.169.0.1', '11.0.0.1'].some(isAllowedPrinterIp));

/* ── E. authentication, origin, host header ── */
head('E — authentication, origin and host header');
const body = Buffer.from([27, 64]);
const H = (t, extra) => Object.assign({ 'Content-Type': 'application/octet-stream', 'X-Target-Host': '127.0.0.1', 'X-Target-Port': String(printer.port), 'X-Job-Id': 'job-E-' + crypto.randomUUID().slice(0, 12) }, t ? { Authorization: 'Bearer ' + t } : {}, extra || {});
let x = await req(BP, '/print', { method: 'POST', headers: H(null), body });
ck('no token → 401, nothing printed', x.status === 401 && x.body.code === 'token_malformed');
x = await req(BP, '/print', { method: 'POST', headers: H(token({ aud: 'other-project' })), body });
ck('token for another project → 401 token_audience', x.status === 401 && x.body.code === 'token_audience', x.body);
x = await req(BP, '/print', { method: 'POST', headers: H(token({ exp: Math.floor(Date.now() / 1000) - 3600 })), body });
ck('expired token → 401 token_expired', x.status === 401 && x.body.code === 'token_expired', x.body);
x = await req(BP, '/print', { method: 'POST', headers: H((function (t) { const i = t.lastIndexOf('.') + 40; return t.slice(0, i) + (t[i] === 'A' ? 'B' : 'A') + t.slice(i + 1); }(token()))), body });
ck('tampered signature → 401 token_signature', x.status === 401 && x.body.code === 'token_signature', x.body);
x = await req(BP, '/print', { method: 'POST', headers: H(token({}, { kid: 'unknown' })), body });
ck('unknown key id → 401 token_kid', x.status === 401 && x.body.code === 'token_kid', x.body);
x = await req(BP, '/print', { method: 'POST', headers: H(token(), { Origin: 'https://evil.example' }), body });
ck('a page from another origin → 403 origin_not_allowed', x.status === 403 && x.body.code === 'origin_not_allowed', x.body);
const rawHost = await new Promise((res) => {
  const s = net.createConnection({ host: '127.0.0.1', port: BP }, () => s.end('GET /ping HTTP/1.1\r\nHost: attacker.example:' + BP + '\r\nConnection: close\r\n\r\n'));
  let d = ''; s.on('data', (c) => { d += c; }); s.on('end', () => res(d)); s.on('error', () => res(''));
});
ck('a foreign Host header (DNS rebinding onto the bridge) → 421', /^HTTP\/1\.1 421/.test(rawHost), rawHost.slice(0, 40));
x = await req(BP, '/print', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } });
ck('Local/Private Network Access preflight from SOKONI → 204 with Allow-Private-Network', x.status === 204 && x.headers.get('access-control-allow-private-network') === 'true' && x.headers.get('access-control-allow-origin') === ORIGIN);
x = await req(BP, '/print', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Private-Network': 'true' } });
ck('the same preflight from another origin → 403, no allow headers', x.status === 403 && !x.headers.get('access-control-allow-private-network'));
x = await req(BP, '/ping', { headers: { Origin: 'https://evil.example' } });
ck('/ping answers any origin with liveness only — no printers, jobs or identity', x.status === 200 && Object.keys(x.body).sort().join() === 'authRequired,name,ok,version');
ck('client signed out → auth-rejected before any request', (await clientCtx({ signedOut: true }).print('127.0.0.1', printer.port, new Uint8Array([1]), 'job-E-signedout1')).state === 'auth-rejected');

/* ── F. browser local-network permission denied ── */
head('F — browser local-network permission denied');
let fetched = 0;
const denied = clientCtx({ navigator: { permissions: { query: (q) => (q.name === 'loopback-network' ? Promise.resolve({ state: 'denied' }) : Promise.reject(new Error('unknown'))) } } });
const origFetch = global.fetch;
r = await denied.status();
ck('permission denied → permission-denied with the site-settings instruction, and no request is attempted', r.state === 'permission-denied' && /local network access/.test(r.message), r);
const denied2 = clientCtx({ port: closedPort, navigator: { permissions: { query: () => Promise.resolve({ state: 'denied' }) } } });
r = await denied2.print('127.0.0.1', printer.port, new Uint8Array([1]), 'job-F-000001', { retryDelayMs: 0 });
ck('a blocked request is reported as permission-denied, not "not installed"', r.state === 'permission-denied', r);

/* ── G. duplicate job ── */
head('G — duplicate job is idempotent');
const n0 = printer.got.length;
const G1 = await B.print('127.0.0.1', printer.port, new Uint8Array(RECEIPT), 'job-G-dup-0001');
const G2 = await B.print('127.0.0.1', printer.port, new Uint8Array(RECEIPT), 'job-G-dup-0001');
await waitGot(printer, n0 + 1); await new Promise((res) => setTimeout(res, 150));   /* then a quiet window: a second copy would land here */
ck('the same job id twice → second answered as duplicate, printer receives ONE receipt', G1.ok && G2.ok && G2.duplicate === true && printer.got.length === n0 + 1, { G1, G2, got: printer.got.length - n0 });
/* In flight: a bridge whose socket send is held open until released, so the window is deterministic. */
let release; const held = new Promise((res) => { release = res; });
const HP = await freePort();
const holding = createBridge({ port: HP, origins: [ORIGIN], projectId: PROJECT, certs, allowLoopbackForTests: true, log: () => {}, sendImpl: () => held.then(() => ({ ok: true })) });
await new Promise((res) => holding.listen(res));
const first = req(HP, '/print', { method: 'POST', headers: H(token(), { 'X-Job-Id': 'job-G-inflight-1' }), body });
await new Promise((res) => setTimeout(res, 100));
const second = await req(HP, '/print', { method: 'POST', headers: H(token(), { 'X-Job-Id': 'job-G-inflight-1' }), body });
release(); const firstR = await first;
const slow = { srv: holding.server };
ck('the same id while the first is still sending → 409 in flight, not a second send', second.status === 409 && second.body.code === 'job_in_flight' && firstR.status === 200, [firstR.status, second.status]);
const f1 = await B.print('127.0.0.1', closedPort, new Uint8Array([1]), 'job-G-retry-01', { retry: false });
ck('a FAILED job may be retried with the same id (failure is not remembered as sent)', f1.ok === false && (await B.print('127.0.0.1', printer.port, new Uint8Array([1]), 'job-G-retry-01', { retry: false })).ok === true);
x = await req(BP, '/print', { method: 'POST', headers: H(token(), { 'X-Job-Id': 'short' }), body });
ck('a missing or malformed job id → 400 job_id_required', x.status === 400 && x.body.code === 'job_id_required');
x = await req(BP, '/print', { method: 'POST', headers: H(token()), body: Buffer.alloc(64 * 1024 + 1) });
ck('a payload over 64 KB → 413', x.status === 413);

/* ── H/I. 58mm and 80mm receipts through the canonical engine ── */
head('H/I — 58mm and 80mm ESC/POS through the canonical engine');
global.window = undefined;
const SP_API = require(path.join(ROOT, 'sokoni-universal-printer.js'));
const sale = { businessName: 'SOKONI Test Shop', receiptNumber: 'R-1', items: [{ name: 'Sugar 1kg', qty: 1, price: 180 }], total: 180 };
const b58 = SP_API.ReceiptRenderer ? new SP_API.ReceiptRenderer('58mm', {}).render('sale', sale) : null;
const b80 = SP_API.ReceiptRenderer ? new SP_API.ReceiptRenderer('80mm', {}).render('sale', sale) : null;
const txt = (b) => Buffer.from(b).toString('latin1');
ck('58mm: 32-column separator, starts with ESC @, ends with a cut', b58 && /(^|[^-])-{32}([^-]|$)/.test(txt(b58)) && !/-{33}/.test(txt(b58)) && b58[0] === 0x1b && b58[1] === 0x40 && /\x1dV/.test(txt(b58)));
ck('80mm: 48-column separator', b80 && /(^|[^-])-{48}([^-]|$)/.test(txt(b80)) && !/-{49}/.test(txt(b80)));
const pr58 = await fakePrinter();
r = await B.print('127.0.0.1', pr58.port, b58, 'job-H-58mm-001');
await waitGot(pr58, 1);
ck('the 58mm receipt travels through the bridge byte-for-byte', r.ok && pr58.got.length === 1 && Buffer.compare(pr58.got[0], Buffer.from(b58)) === 0, { r, got: pr58.got.map((g) => g.length), want: b58 && b58.length });

/* ── the canonical engine's NetworkAdapter uses the bridge ── */
head('Engine — NetworkAdapter bridge route');
global.window = { SokoniPrintBridge: B };
const NA = new SP_API.NetworkAdapter();
const prE = await fakePrinter();
let connErr = null; try { await NA.connect({ endpoint: 'bridge://127.0.0.1:' + prE.port, type: 'network', name: 'Test' }); } catch (e) { connErr = e; }
ck('connect(bridge://host:port) proves the route (bridge up + printer answering)', !connErr && NA.ok === true, connErr && connErr.message);
await NA.write(new Uint8Array(RECEIPT));
await waitGot(prE, 1);
ck('write() delivers the bytes through the bridge', prE.got.length === 1 && Buffer.compare(prE.got[0], RECEIPT) === 0);
const NA2 = new SP_API.NetworkAdapter();
let e2 = null; try { await NA2.connect({ endpoint: 'bridge://127.0.0.1:' + closedPort, type: 'network' }); } catch (e) { e2 = e; }
ck('connect to a dead printer throws OFFLINE with the bridge\'s reason (never "connected")', e2 && e2.code === 'PRINTER_OFFLINE' && e2.state === 'printer-unreachable' && NA2.ok !== true, e2 && { code: e2.code, state: e2.state });
NA.ok = true; NA._bridge = { host: '127.0.0.1', port: closedPort };
let e3 = null; try { await NA.write(new Uint8Array([1])); } catch (e) { e3 = e; }
ck('a write that fails marks the adapter disconnected and throws — never a silent success', e3 && NA.ok === false && e3.state === 'printer-unreachable');
ck('saveNetworkPrinter(name, host, port) stores bridge://host:port; (name, http-endpoint) keeps the endpoint', (() => {
  const store = {}; global.localStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } };
  SP_API.saveNetworkPrinter('Front', '192.168.1.50', 9100); SP_API.saveNetworkPrinter('HTTP', 'http://192.168.1.60');
  const list = JSON.parse(store.spp_net_printers || '[]');
  return list.some((p) => p.endpoint === 'bridge://192.168.1.50:9100') && list.some((p) => p.endpoint === 'http://192.168.1.60') && SP_API.networkPrinters().length === 1;
})());

/* ── every network caller uses the one client; no cloud relay anywhere ── */
head('Callers — one route, no cloud relay');
const CALLERS = ['sokoni-pos-print.js', 'sokoni-printer-providers.js', 'sokoni-connection-manager.js', 'sokoni-printer-discovery.js', 'pos-printer.js', 'sokoni-universal-printer.js'];
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
for (const f of CALLERS) {
  const code = strip(read(f));
  ck(f + ': no posPrint / cloudfunctions / hard-coded localhost:9101 in code', !/posPrint|cloudfunctions\.net|localhost:9101|127\.0\.0\.1:9101/.test(code));
}
ck('sokoni-pos-print / providers / connection-manager / pos-printer send through SokoniPrintBridge.print',
   ['sokoni-pos-print.js', 'sokoni-printer-providers.js', 'sokoni-connection-manager.js', 'pos-printer.js'].every((f) => /SokoniPrintBridge|\bB\.print\(/.test(strip(read(f))) && /\.print\(/.test(strip(read(f)))));
const PAGES = ['merchant-v2.html', 'merchant.html', 'pos-checkout.html', 'pos-hardware-wizard.html', 'pos-marketplace.html', 'pos-printer-setup.html', 'pos-setup.html', 'pos-v2.html', 'pos.html', 'seller-fulfilment.html', 'pos-hardware-setup.html', 'commissioning.html', 'print-station.html'];
ck('every page that loads a network-capable printer module loads the bridge client first', PAGES.every((p) => {
  const s = read(p); const i = s.search(/src="\/?sokoni-print-bridge\.js"/);
  const j = s.search(/src="\/?(sokoni-universal-printer|sokoni-pos-print|sokoni-connection-manager|sokoni-printer-discovery|pos-printer)\.js"/);
  return i >= 0 && j >= 0 && i < j;
}), PAGES.filter((p) => !/sokoni-print-bridge\.js/.test(read(p))));

/* ── headers: exactly what the bridge needs, nothing broader ── */
head('Headers — local-network permission and the one bridge origin');
const FJ = JSON.parse(read('firebase.json'));
const hdrs = [].concat(FJ.hosting)[0].headers.flatMap((h) => h.headers || []);
const PP = (hdrs.find((h) => h.key === 'Permissions-Policy') || {}).value || '';
const CSP = (hdrs.find((h) => h.key === 'Content-Security-Policy') || {}).value || '';
const connect = (CSP.split(';').find((d) => /^\s*connect-src/.test(d)) || '');
ck('Permissions-Policy grants local-network=(self) and loopback-network=(self)', /local-network=\(self\)/.test(PP) && /loopback-network=\(self\)/.test(PP));
ck('existing hardware grants kept (bluetooth, usb, serial, hid)', ['bluetooth', 'usb', 'serial', 'hid'].every((k) => new RegExp(k + '=\\(self\\)').test(PP)));
ck('connect-src permits EXACTLY http://127.0.0.1:9101', /\shttp:\/\/127\.0\.0\.1:9101(\s|$)/.test(connect));
ck('no broad private-network or ws:// / http wildcard was added', !/(192\.168|10\.\d|172\.(1[6-9]|2\d|3[01])|\*:|http:\/\/\*|ws:\/\/|localhost)/.test(connect), connect.match(/http:\/\/[^\s]+/g));
ck('no Connection-Allowlist header exists (nothing to extend)', !hdrs.some((h) => /connection-allowlist/i.test(h.key)));

bridge.close(); strict.close(); [printer, slow, pr58, prE].forEach((p) => p.srv.close());
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e && e.stack || e); process.exit(2); });
