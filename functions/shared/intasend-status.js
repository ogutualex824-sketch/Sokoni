'use strict';
/**
 * intasendCollectionStatus — the ONE way SOKONI asks IntaSend for a collection's state (2026-10-03).
 *
 * Extracted from the only existing call (verifyIntasendPayment, index.js ~2745 on the 68811e1 lineage):
 *   GET {payment|sandbox}.intasend.com/api/v1/payment/collection/?invoice_id=<ref>
 *   Authorization: Token <private key>
 * results matched by invoice_id / tracking_id / api_ref; `state` is the authority (COMPLETE | FAILED | PENDING …).
 * For admin reconciliation (e.g. Foundation pledges in 'review', sokoni-4d) and any future re-verification — never a
 * second way of calling IntaSend. verifyIntasendPayment is left unchanged (it is a live path).
 *
 * The caller supplies the key from its own declared secret (INTASEND_PRIVATE_KEY); this module never reads secrets,
 * never logs the key, and never logs a full response body.
 * @returns {Promise<{ok:true, found:boolean, state?, value?, net_amount?, charges?, currency?, api_ref?, invoice_id?}
 *                  | {ok:false, error:'NO_KEY'|'BAD_REF'|'HTTP_<n>'|'NETWORK'|'BAD_RESPONSE'}>}
 */
async function intasendCollectionStatus(ref, { privateKey, live = true, fetchImpl } = {}) {
  const r = String(ref || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(r)) return { ok: false, error: 'BAD_REF' };
  if (!privateKey) return { ok: false, error: 'NO_KEY' };
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, error: 'NETWORK' };
  const base = live ? 'https://payment.intasend.com' : 'https://sandbox.intasend.com';
  let res;
  try {
    res = await f(base + '/api/v1/payment/collection/?invoice_id=' + encodeURIComponent(r), {
      headers: { Authorization: 'Token ' + privateKey, 'Content-Type': 'application/json' },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    });
  } catch (_) { return { ok: false, error: 'NETWORK' }; }
  if (!res || !res.ok) return { ok: false, error: 'HTTP_' + (res ? res.status : 0) };
  let data;
  try { data = await res.json(); } catch (_) { return { ok: false, error: 'BAD_RESPONSE' }; }
  const results = (data && data.results) || (Array.isArray(data) ? data : (data ? [data] : []));
  const p = results.find((x) => x && (x.invoice_id === r || x.tracking_id === r || x.api_ref === r));
  if (!p) return { ok: true, found: false };
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return { ok: true, found: true, state: String(p.state || '').toUpperCase() || null, value: num(p.value), net_amount: num(p.net_amount),
    charges: num(p.charges), currency: p.currency || null, api_ref: p.api_ref || null, invoice_id: p.invoice_id || null };
}
module.exports = { intasendCollectionStatus };
