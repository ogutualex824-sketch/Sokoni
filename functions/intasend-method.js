/* ══════════════════════════════════════════════════════════════════════════════════════
   WHAT THE CUSTOMER ACTUALLY PAID WITH — read from the provider, never assumed.
   ══════════════════════════════════════════════════════════════════════════════════════
   SOKONI opens an IntaSend checkout and IntaSend presents whatever methods the account
   has enabled. The customer then chooses. Which means the method SOKONI *requested* and
   the method the customer *used* are two different facts, and only one of them is true.

   Every method figure in this platform used to be the first one. `pos-intasend-initiation`
   writes `method` onto the intent at initiation and `finalizeFromWebhook(db, apiRef,
   state, amount)` is not even handed the payload, so the confirmation could not correct it
   if it wanted to. Open a checkout as CARD, let the customer pay by M-PESA, and
   businessWallets records CARD forever. Nothing breaks; the money arrives; the ledger is
   simply wrong, and stays wrong until somebody reconciles against IntaSend by hand.

   THIS MODULE REFUSES RATHER THAN GUESSES. If the payload carries no method we can
   recognise, it returns ok:false. It does NOT fall back to what was requested — a fallback
   is precisely how a guess acquires the appearance of a fact, and it would make the failure
   invisible at exactly the moment attribution matters.

   IT ALSO DOES NOT DECIDE WHAT TO DO ABOUT THAT. Callers differ: a wallet credit may need
   to record UNKNOWN and carry on, while a collection proof may need to refuse. Handing
   back a verdict rather than a value keeps that decision where the consequences are.

   FIELD NAMES ARE TREATED AS UNVERIFIED. The exact key IntaSend uses is not confirmed
   against a real production payload — the webhook logs the raw body precisely so it can
   be, and until then this searches several plausible positions and reports which one hit
   (`field`). A normaliser that silently matched nothing would look identical to one that
   worked, so the miss is always reported, never swallowed.
   ══════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

/* SOKONI's canonical vocabulary. CASH exists in the wallet but can never come from a
   provider webhook — cash is, definitionally, money that never reached a rail. */
const CANONICAL = ['MPESA', 'CARD', 'BANK'];

/* Provider spelling -> canonical. Both the hyphenated API forms IntaSend documents
   (`M-PESA`, `CARD-PAYMENT`, `BANK-PAYMENT`) and the bare forms, because a provider that
   returns a different spelling than it accepts is common and costs nothing to absorb. */
const PROVIDER_MAP = {
  'M-PESA':        'MPESA',
  'MPESA':         'MPESA',
  'M_PESA':        'MPESA',
  'CARD-PAYMENT':  'CARD',
  'CARD_PAYMENT':  'CARD',
  'CARD':          'CARD',
  'BANK-PAYMENT':  'BANK',
  'BANK_PAYMENT':  'BANK',
  'BANK':          'BANK',
};

/* Positions the method may occupy, most specific first. `provider` is IntaSend's
   documented field; the rest are defensive, and each is reported by name when it hits so
   a wrong guess shows up in logs instead of hiding behind a plausible answer. */
const FIELDS = ['provider', 'payment_method', 'paymentMethod', 'method', 'channel'];

const REASON = {
  ABSENT:       'provider-method-absent',
  UNRECOGNISED: 'provider-method-unrecognised',
  NO_PAYLOAD:   'no-payload',
};

function _read(obj, field) {
  if (!obj || typeof obj !== 'object') return null;
  const v = obj[field];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * Read the method the customer actually used out of an IntaSend webhook payload.
 *
 * @param   {object} payload  the webhook body, flat or `{ invoice: {...} }`
 * @returns {{ ok: boolean, method: string|null, raw: string|null,
 *             field: string|null, reason: string|null }}
 *
 * ok:true   `method` is one of CANONICAL and is what the provider reported.
 * ok:false  attribution is NOT available. `raw` carries whatever was found (or null) so a
 *           caller can log the unrecognised spelling and add it here deliberately, rather
 *           than a future reader inferring the mapping from a stack trace.
 */
function normalizeIntasendPaymentMethod(payload) {
  const miss = (reason, raw, field) => ({
    ok: false, method: null, raw: raw || null, field: field || null, reason,
  });

  if (!payload || typeof payload !== 'object') return miss(REASON.NO_PAYLOAD, null, null);

  /* The nested `invoice` object is checked FIRST. IntaSend's documented payload is flat,
     but where both exist the invoice is the record of the transaction itself, and the root
     may carry the request's echo — preferring the root would reintroduce exactly the
     "what we asked for" reading this module exists to eliminate. */
  const sources = [
    [payload.invoice, 'invoice.'],
    [payload, ''],
  ];

  let sawRaw = null, sawField = null;
  for (const [obj, prefix] of sources) {
    for (const field of FIELDS) {
      const raw = _read(obj, field);
      if (!raw) continue;
      const mapped = PROVIDER_MAP[raw.toUpperCase()];
      if (mapped) return { ok: true, method: mapped, raw, field: prefix + field, reason: null };
      /* Found something, but do not understand it. Keep looking — another field may be
         recognisable — while remembering this so the refusal can name it. */
      if (!sawRaw) { sawRaw = raw; sawField = prefix + field; }
    }
  }

  return sawRaw
    ? miss(REASON.UNRECOGNISED, sawRaw, sawField)
    : miss(REASON.ABSENT, null, null);
}

/**
 * The value to STORE for a caller that must record something regardless. Returns the
 * canonical method, or 'UNKNOWN' — never the requested method.
 *
 * 'UNKNOWN' is a real, readable state meaning "money arrived, attribution did not". It is
 * deliberately not a silent default: a reconciliation that finds UNKNOWN rows knows
 * exactly what to go and look up, whereas one finding a wrong-but-plausible CARD has no
 * way to discover it is wrong at all.
 */
function methodForRecord(payload) {
  const r = normalizeIntasendPaymentMethod(payload);
  return r.ok ? r.method : 'UNKNOWN';
}

module.exports = {
  normalizeIntasendPaymentMethod,
  methodForRecord,
  CANONICAL,
  PROVIDER_MAP,
  FIELDS,
  REASON,
};
