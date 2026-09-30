'use strict';

/**
 * SOKONI PAYMENT METHOD CAPABILITY
 * ────────────────────────────────────────────────────────────────────────────
 * Which payment methods a buyer may actually be offered, and why.
 *
 * The contract is "every method IntaSend has enabled for this account" — NOT a small
 * permanent list. A method the provider enables should reach buyers without anybody
 * editing a checkout page.
 *
 * But "all IntaSend methods" cannot mean blindly accepting every string the provider
 * might return. A method SOKONI cannot reconcile is not a payment method; it is a way to
 * take somebody's money and lose it. So a method is offered when TWO things are true:
 *
 *      the PROVIDER has enabled it        ∩        SOKONI can RECONCILE it
 *
 * ── THE EIGHT CONTROLS ───────────────────────────────────────────────────────
 * Reconcilable means all eight of these are answerable for the method:
 *
 *   route             a payment can be created and routed with it
 *   identify          the confirmation carries a provider reference we can match
 *   verify            its state can be classified as settled, failed or pending
 *   reconcileMoney    the confirmation carries an amount AND a currency
 *   determineTender   the payload names what actually paid, so we do not record the
 *                     REQUESTED method as the actual one
 *   attachBuyer       the confirmation can be tied back to the intent, and so to a buyer
 *   replaySafe        a repeated confirmation is idempotent on the provider reference
 *   settleLedger      there is a ledger destination for this tender
 *
 * ── WHY THIS IS STRUCTURAL AND NOT A LIST ────────────────────────────────────
 * The existing verification is already method-agnostic: it matches a reference, compares
 * an amount and a currency, classifies a state, and reads the tender FROM the payload.
 * Any method whose settlement carries those fields is reconcilable by the code that
 * already exists. That is why a new provider method needs no new checkout implementation
 * — and why one whose settlement does NOT carry them must be withheld.
 *
 * ── WITHHELD IS NOT HIDDEN ───────────────────────────────────────────────────
 * A method the provider enabled but SOKONI cannot reconcile is reported with the controls
 * it fails, rather than silently dropped. Silently dropping it means nobody ever
 * implements it; silently offering it means a buyer pays into a hole.
 */

const CONTROL = Object.freeze({
  ROUTE: 'route',
  IDENTIFY: 'identify',
  VERIFY: 'verify',
  RECONCILE_MONEY: 'reconcileMoney',
  DETERMINE_TENDER: 'determineTender',
  ATTACH_BUYER: 'attachBuyer',
  REPLAY_SAFE: 'replaySafe',
  SETTLE_LEDGER: 'settleLedger',
});

const ALL_CONTROLS = Object.freeze(Object.keys(CONTROL).map((k) => CONTROL[k]));

/**
 * WHAT THE STANDARD INTASEND INVOICE GIVES US.
 *
 * Every method IntaSend settles through its ordinary invoice shape carries a reference, a
 * state, an amount, a currency and a method token — which is exactly the seven the
 * existing verification needs, plus a ledger destination that follows from the tender.
 *
 * A method declared to use this shape is reconcilable by code that already exists. One
 * that is not must declare what it DOES carry, and is judged on that.
 */
const STANDARD_INVOICE_CONTROLS = Object.freeze(ALL_CONTROLS.slice());

/**
 * The methods SOKONI has actually settled and reconciled in production. Kept as a
 * separate fact from "declared reconcilable", because a declaration is a claim and this
 * is a record. Used to mark an offered method as PROVEN or PROVISIONAL, so an operator
 * can see which is which without that distinction blocking a genuinely safe method.
 */
const PROVEN_IN_PRODUCTION = Object.freeze(['MPESA', 'CARD', 'BANK']);

/* Never a provider method, whatever a configuration says. Cash is settled at a drawer,
   points are a merchant-funded reward, and a wallet balance never left SOKONI. */
const INTERNAL_TENDERS = Object.freeze(['CASH', 'POINTS', 'WALLET', 'CREDIT', 'VOUCHER']);

function refuse(reason, detail) {
  return { ok: false, reason, detail: detail == null ? null : detail };
}
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function norm(m) {
  return String(m == null ? '' : m).trim().toUpperCase();
}

/**
 * What controls does this method satisfy?
 *
 * `declared` is what the configuration says about the method. The common case —
 * `{ standardInvoice: true }` — means it settles through IntaSend's ordinary invoice and
 * therefore satisfies every control the existing code already implements.
 */
function controlsFor(method, declared) {
  const m = norm(method);
  if (!m) return refuse('NO_METHOD');
  const d = isPlainObject(declared) ? declared : {};

  if (INTERNAL_TENDERS.indexOf(m) > -1) {
    return refuse('NOT_A_PROVIDER_TENDER', m);
  }

  if (d.standardInvoice === true) {
    return { ok: true, method: m, controls: STANDARD_INVOICE_CONTROLS.slice(), basis: 'STANDARD_INVOICE' };
  }

  /* An explicit list, for a method that settles some other way. */
  if (Array.isArray(d.controls)) {
    const controls = d.controls.map((c) => String(c)).filter((c) => ALL_CONTROLS.indexOf(c) > -1);
    return { ok: true, method: m, controls, basis: 'DECLARED' };
  }

  /* NOTHING DECLARED. The safe answer is "we do not know how to reconcile this", not
     "it is probably fine" — the second is how a false-success payment path is born. */
  return { ok: true, method: m, controls: [], basis: 'UNDECLARED' };
}

/**
 * Can SOKONI reconcile this method? Names the controls it fails, so the gap is
 * actionable rather than merely a refusal.
 */
function assess(method, declared) {
  const c = controlsFor(method, declared);
  if (!c.ok) return c;

  const missing = ALL_CONTROLS.filter((ctrl) => c.controls.indexOf(ctrl) === -1);
  return {
    ok: true,
    method: c.method,
    basis: c.basis,
    reconcilable: missing.length === 0,
    missing,
    proven: PROVEN_IN_PRODUCTION.indexOf(c.method) > -1,
  };
}

/**
 * THE OFFERABLE SET.
 *
 * Given what the provider has enabled and what it declares about each method, which may
 * a buyer choose — and which are withheld, and why.
 *
 * `config.enabledMethods` is the provider's enabled list. `config.methodCapability` maps
 * a method to what its settlement carries. A method enabled with no capability declared
 * is WITHHELD, not offered: the account can enable whatever it likes, and SOKONI still
 * only takes money it can account for.
 */
function offerableMethods(config) {
  const c = isPlainObject(config) ? config : {};
  const enabled = Array.isArray(c.enabledMethods) ? c.enabledMethods : null;
  const caps = isPlainObject(c.methodCapability) ? c.methodCapability : {};

  /* WITH NO PROVIDER CONFIGURATION AT ALL, the methods proven in production are offered.
     An empty offer set would close the tills, and closing the tills because a
     configuration document is missing is a worse failure than using what we have
     actually settled before. */
  if (!enabled || !enabled.length) {
    return {
      ok: true,
      source: 'INCUMBENT',
      offered: PROVEN_IN_PRODUCTION.map((m) => ({ method: m, proven: true, basis: 'PROVEN_IN_PRODUCTION' })),
      withheld: [],
    };
  }

  const offered = [];
  const withheld = [];
  const seen = {};

  enabled.forEach((raw) => {
    const m = norm(raw);
    if (!m || seen[m]) return;
    seen[m] = 1;

    if (INTERNAL_TENDERS.indexOf(m) > -1) {
      withheld.push({ method: m, reason: 'NOT_A_PROVIDER_TENDER',
                      detail: 'settled inside SOKONI; the provider never saw it' });
      return;
    }

    /* A method proven in production needs no declaration to be offered — its capability
       is a matter of record rather than of configuration. */
    const declared = caps[m] || (PROVEN_IN_PRODUCTION.indexOf(m) > -1 ? { standardInvoice: true } : null);
    const a = assess(m, declared);
    if (!a.ok) { withheld.push({ method: m, reason: a.reason, detail: a.detail }); return; }

    if (a.reconcilable) {
      offered.push({ method: m, proven: a.proven, basis: a.basis });
    } else {
      /* REPORTED, NOT DROPPED. Naming the controls it fails is what turns this into
         something somebody can implement. */
      withheld.push({ method: m, reason: 'CANNOT_RECONCILE', missing: a.missing, basis: a.basis });
    }
  });

  if (!offered.length) {
    return {
      ok: true, source: 'INCUMBENT',
      offered: PROVEN_IN_PRODUCTION.map((m) => ({ method: m, proven: true, basis: 'PROVEN_IN_PRODUCTION' })),
      withheld,
      detail: 'configuration offered no reconcilable method',
    };
  }

  return { ok: true, source: 'CONFIG', offered, withheld };
}

/** Is this exact method offerable right now? The single gate a caller should ask. */
function isOffered(method, config) {
  const m = norm(method);
  if (!m) return refuse('NO_METHOD');
  const set = offerableMethods(config);
  const hit = set.offered.filter((o) => o.method === m)[0];
  if (hit) return { ok: true, method: m, proven: hit.proven, source: set.source };

  const held = set.withheld.filter((w) => w.method === m)[0];
  if (held) return refuse(held.reason, held.missing ? held.missing.join(',') : held.detail);
  return refuse('METHOD_NOT_ENABLED', m);
}

module.exports = {
  CONTROL, ALL_CONTROLS, STANDARD_INVOICE_CONTROLS, PROVEN_IN_PRODUCTION, INTERNAL_TENDERS,
  controlsFor, assess, offerableMethods, isOffered,
};
