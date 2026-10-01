/* ============================================================================
   IntaSend Send-Money — bank (PesaLink) and M-PESA B2B (Till / PayBill) rails (2026-10-01)
   ----------------------------------------------------------------------------
   The SAME IntaSend send-money contract as finos-utils.intasendB2C (proven for MPESA-B2C):
     POST {base}/api/v1/send-money/initiate/   Authorization: Bearer <secret>
     { provider, currency:'KES', requires_approval:'NO', transactions:[ … ] }
   Providers used here (IntaSend send-money documentation):
     PESALINK   transactions[{ name, account:<bank account>, bank_code, amount, narrative }]
     MPESA-B2B  transactions[{ name, account:<till|paybill>, account_type:'TillNumber'|'PayBill',
                               account_reference (PayBill only), amount, narrative }]
   Supporting calls:
     GET  /api/v1/send-money/bank-codes/ke/      → the provider's live bank catalogue (cached by the caller)
     POST /api/v1/send-money/validate-account/   → beneficiary validation where the provider supports it
   UNPROVEN against SOKONI's live/sandbox account (MPESA-B2C is the only rail proven on this platform):
   every response is parsed defensively; an unreadable answer is never treated as success.
   No secret is ever logged — only the masked destination and the HTTP outcome.
   ============================================================================ */
'use strict';
const base = () => (process.env.INTASEND_SANDBOX === 'true' ? 'https://sandbox.intasend.com' : 'https://payment.intasend.com');
const mask = (s) => { s = String(s || ''); return s.length <= 4 ? '****' : '****' + s.slice(-4); };

async function call(privKey, method, path, body) {
  const res = await fetch(base() + path, {
    method, headers: { Authorization: 'Bearer ' + privKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let parsed = null; try { parsed = JSON.parse(text); } catch (_) {}
  return { ok: res.ok, http: res.status, body: parsed, raw: parsed ? null : String(text).slice(0, 160) };
}
function gatewayError(r, what) {
  const b = r.body || {};
  const code = (b.errors && b.errors[0] && b.errors[0].code) || b.code || b.error_code || 'HTTP_' + r.http;
  const msg = (b.errors && b.errors[0] && b.errors[0].detail) || b.detail || b.message || r.raw || '';
  const e = new Error('IntaSend ' + what + ' failed (' + r.http + '): [' + code + '] ' + String(msg).slice(0, 160));
  e.gateway = { name: 'IntaSend', http: r.http, code, message: String(msg).slice(0, 160) };
  return e;
}

/* dest: { type:'BANK', accountNumber, bankCode, accountName } | { type:'TILL', tillNumber } |
         { type:'PAYBILL', paybillNumber, accountRef } */
function transactionFor(dest, amountKES, name, narrative) {
  const amount = Math.round(Number(amountKES));
  if (dest.type === 'BANK') return { provider: 'PESALINK', tx: { name: name || dest.accountName, account: dest.accountNumber, bank_code: dest.bankCode, amount, narrative } };
  if (dest.type === 'TILL') return { provider: 'MPESA-B2B', tx: { name, account: dest.tillNumber, account_type: 'TillNumber', amount, narrative } };
  if (dest.type === 'PAYBILL') return { provider: 'MPESA-B2B', tx: { name, account: dest.paybillNumber, account_type: 'PayBill', account_reference: dest.accountRef, amount, narrative } };
  throw new Error('Unsupported destination type ' + dest.type);
}

async function sendMoney(privKey, dest, { amountKES, name, narrative }) {
  const { provider, tx } = transactionFor(dest, amountKES, name, narrative || 'SOKONI Foundation support');
  console.log('[intasendSendMoney] contract', JSON.stringify({ endpoint: '/api/v1/send-money/initiate/', provider, amount: tx.amount, account: mask(tx.account), env: process.env.INTASEND_SANDBOX === 'true' ? 'sandbox' : 'live' }));
  const r = await call(privKey, 'POST', '/api/v1/send-money/initiate/', { provider, currency: 'KES', requires_approval: 'NO', transactions: [tx] });
  console.log('[intasendSendMoney] response', JSON.stringify({ http: r.http, ok: r.ok }));
  if (!r.ok || !r.body) throw gatewayError(r, 'send-money');
  return { trackingId: r.body.tracking_id || r.body.file_id || null, raw: r.body };
}

async function bankCodes(privKey) {
  const r = await call(privKey, 'GET', '/api/v1/send-money/bank-codes/ke/');
  if (!r.ok || !Array.isArray(r.body)) throw gatewayError(r, 'bank-codes');
  return r.body.map((b) => ({ bankCode: String(b.bank_code || b.code || ''), bankName: String(b.bank_name || b.name || '') }))
    .filter((b) => /^[A-Za-z0-9]{1,10}$/.test(b.bankCode) && b.bankName);
}

/* → { status:'validated', accountName } | { status:'mismatch' } | { status:'unavailable', reason } */
async function validateAccount(privKey, dest) {
  const { provider, tx } = transactionFor(dest, 1, '', '');
  let r;
  try { r = await call(privKey, 'POST', '/api/v1/send-money/validate-account/', { provider, account: tx.account, bank_code: tx.bank_code || undefined, account_type: tx.account_type || undefined }); }
  catch (e) { return { status: 'unavailable', reason: 'network' }; }
  if (!r.ok || !r.body) return { status: 'unavailable', reason: 'HTTP_' + r.http };
  const b = r.body;
  const name = b.account_name || b.name || (b.data && b.data.account_name) || null;
  const valid = b.valid === true || b.status === 'VALID' || b.status === 'valid' || !!name;
  if (b.valid === false || b.status === 'INVALID' || b.status === 'invalid') return { status: 'mismatch' };
  return valid ? { status: 'validated', accountName: name ? String(name).slice(0, 100) : null } : { status: 'unavailable', reason: 'unrecognised response' };
}

module.exports = { sendMoney, bankCodes, validateAccount, _test: { transactionFor } };
