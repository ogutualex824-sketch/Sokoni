'use strict';
/**
 * NET FIREWALL for money suites — ONE implementation (b2 finding 2026-10-04: a positive control reached IntaSend's LIVE
 * send-money API and failed only because no key was loaded).
 *
 *   require('./lib/net-firewall').install();     // FIRST line of a suite, before any functions module loads
 *
 * - blanks payment-provider secrets in process.env and forces IntaSend sandbox mode;
 * - replaces globalThis.fetch and wraps http/https request/get: any call to a PAYMENT HOST is refused (fetch resolves a
 *   599 "blocked" response; http/https throw) and COUNTED;
 * - FAIL-CLOSED: on process exit, if a single payment-host call was attempted, prints
 *   "FAIL  NET-FIREWALL …" and forces a non-zero exit code — a suite cannot pass silently even if it never asserts.
 * Non-payment calls are left alone (suites that need other hosts keep working). Returns { attempts(), urls }.
 */
const PAYMENT_HOSTS = /(^|[./@])(intasend\.com|sandbox\.intasend\.com|safaricom\.co\.ke|stripe\.com|pesapal\.com|flutterwave\.com|paystack\.co|paypal\.com)/i;
const SECRETS = ['INTASEND_PRIVATE_KEY', 'INTASEND_SECRET_KEY', 'INTASEND_PUBLISHABLE_KEY', 'INTASEND_WEBHOOK_CHALLENGE', 'DARAJA_CONSUMER_KEY',
  'DARAJA_CONSUMER_SECRET', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'STRIPE_SECRET_KEY'];

function install() {
  if (global.__SOKONI_NET_FIREWALL__) return global.__SOKONI_NET_FIREWALL__;
  for (const k of SECRETS) process.env[k] = '';
  process.env.INTASEND_SANDBOX = 'true';
  const state = { count: 0, urls: [] };
  const hit = (u) => { const s = String(u || ''); if (PAYMENT_HOSTS.test(s)) { state.count++; state.urls.push(s.slice(0, 200)); return true; } return false; };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = url && url.url ? url.url : url;
    if (hit(u)) return { ok: false, status: 599, headers: { get: () => null }, json: async () => ({ blocked_by_net_firewall: true }), text: async () => 'blocked by net firewall' };
    if (typeof realFetch === 'function') return realFetch(url, opts);
    throw new Error('fetch unavailable');
  };
  for (const m of ['https', 'http']) {
    const mod = require(m); const origReq = mod.request, origGet = mod.get;
    const target = (o) => (typeof o === 'string' ? o : o && (o.href || o.hostname || o.host)) || '';
    mod.request = function (o, ...r) { if (hit(target(o))) throw new Error('blocked by net firewall: ' + target(o)); return origReq.call(this, o, ...r); };
    mod.get = function (o, ...r) { if (hit(target(o))) throw new Error('blocked by net firewall: ' + target(o)); return origGet.call(this, o, ...r); };
  }
  process.on('exit', () => {
    if (state.count > 0) {
      console.log(`  FAIL  NET-FIREWALL — ${state.count} call(s) to a payment host were attempted during this suite: ${state.urls.slice(0, 3).join(' | ')}`);
      process.exitCode = 1;
    }
  });
  global.__SOKONI_NET_FIREWALL__ = { attempts: () => state.count, urls: state.urls, PAYMENT_HOSTS };
  return global.__SOKONI_NET_FIREWALL__;
}
module.exports = { install, PAYMENT_HOSTS };
