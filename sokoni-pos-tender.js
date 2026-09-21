/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI POS — MULTI-TENDER ENGINE
   sokoni-pos-tender.js

   One sale, N tenders. Cash + M-PESA + card + anything else the IntaSend
   account has enabled, in the same transaction, in any combination.

   ── WHY THIS EXISTS ────────────────────────────────────────────────────────

   pos.js already splits a sale two ways, and it does it by MONKEY-PATCHING
   `payment.complete` and `mpesa.sendSTK` at runtime (pos.js:4176-4200):

       const origComplete = payment.complete;
       payment.complete = async function(payInfo) {
         payment.complete = origComplete;          // restore, then hope
         …
       };

   That works for exactly two tenders, only ever cash+M-PESA, and only if
   nothing throws between the swap and the restore. A third tender cannot be
   expressed, and a failure mid-flight leaves the till with a patched
   `payment.complete` — the next unrelated sale inherits it.

   So the allocation is modelled instead of patched. This module is PURE: no
   DOM, no Firestore, no network, no clock. It computes and it refuses. The UI
   renders what it returns; the server remains the authority for whether money
   actually arrived.

   ── THE UNIT ───────────────────────────────────────────────────────────────

   INTEGER CENTS, everywhere, for the reason money-authority.js documents at
   length: the platform already shipped two callables 100x apart because one
   took shillings and one took cents under the same parameter name. Floats also
   cannot represent a tender split exactly — 4850/3 in shillings-as-float
   leaves a residue that shows up as a one-cent unsettled balance the cashier
   cannot clear. Conversion happens once, at the boundary, in `fromShillings`.

   ── THE INVARIANT ──────────────────────────────────────────────────────────

       sum(allocations) - changeDue === total        (a sale is settled)

   Change is only ever given from CASH. An external rail cannot hand notes
   back, so no external tender may exceed the balance remaining. That is not a
   policy choice; a KES 5,000 card swipe against a KES 4,850 bill is a KES 150
   refund obligation on a rail with no refund path at the till.
═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SPosTender = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── Money ──────────────────────────────────────────────────────────────
     Shillings in, cents out, rounded ONCE. `Math.round(x * 100)` and never
     `Math.round(x) * 100` — the latter silently discards cents and is a bug
     this codebase has already shipped once. */
  function fromShillings(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100);
  }
  function toShillings(cents) { return (Number(cents) || 0) / 100; }
  function fmt(cents) {
    return (Number(cents) || 0 / 1).toLocaleString('en-KE', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }
  function fmtKES(cents) {
    return 'KES ' + toShillings(cents).toLocaleString('en-KE', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  /* ── Tender kinds ───────────────────────────────────────────────────────
     `CASH` is settled the instant the cashier takes the notes; it is the only
     kind that can overpay, because it is the only kind that can give change.

     `EXTERNAL` is settled by webhookIntasend and NOT before. A tile turning
     green in the till is a request, not a receipt — the whole point of the
     payment audit.

     `RECORDED` is money that already moved outside SOKONI and is being written
     down: a merchant's own M-PESA Till code the customer paid directly. It
     cannot overpay either, and it is deliberately distinguishable from
     EXTERNAL forever after, because "we initiated this" and "we were told this
     happened" are different claims. */
  const KIND = Object.freeze({
    CASH:     'cash',
    EXTERNAL: 'external',
    RECORDED: 'recorded',
  });

  /* The methods that need no IntaSend capability at all. Cash is cash, and a
     Till code the customer already paid does not touch our gateway. These are
     ALWAYS available, which is why the till never goes dark when the probe has
     not run or the network is down. */
  const ALWAYS_AVAILABLE = Object.freeze([
    { id: 'cash',       label: 'Cash',        icon: '💵', kind: KIND.CASH },
    { id: 'mpesa_till', label: 'M-PESA Till', icon: '🏪', kind: KIND.RECORDED, needsRef: true },
  ]);

  /* ── Sheet ──────────────────────────────────────────────────────────────
     A tender sheet is the whole payment state of one sale. It is a plain
     object so it can be logged, diffed and asserted on without ceremony. */
  function createSheet(totalCents, methods) {
    const total = Math.max(0, Math.round(Number(totalCents) || 0));
    return {
      totalCents:  total,
      methods:     Array.isArray(methods) ? methods.slice() : ALWAYS_AVAILABLE.slice(),
      allocations: [],          /* [{ methodId, kind, cents, ref }] */
    };
  }

  function methodSpec(sheet, methodId) {
    return (sheet.methods || []).find((m) => m.id === methodId) || null;
  }

  /** Total allocated across every tender, cash included (change not deducted). */
  function allocatedCents(sheet) {
    return (sheet.allocations || []).reduce((s, a) => s + (Number(a.cents) || 0), 0);
  }

  /** Cash allocated. Only this may exceed what is owed. */
  function cashCents(sheet) {
    return (sheet.allocations || [])
      .filter((a) => a.kind === KIND.CASH)
      .reduce((s, a) => s + (Number(a.cents) || 0), 0);
  }

  /** Everything that is not cash. */
  function nonCashCents(sheet) {
    return allocatedCents(sheet) - cashCents(sheet);
  }

  /**
   * What is still owed. Never negative — an overpayment is CHANGE, not a
   * negative balance, and conflating the two is how a till ends up showing
   * "-150 due" and a cashier ends up guessing.
   */
  function balanceCents(sheet) {
    return Math.max(0, sheet.totalCents - allocatedCents(sheet));
  }

  /**
   * Change owed to the customer. Only cash can produce it.
   *
   * Computed as the overpayment, which given the non-cash ceiling below can
   * only ever have come from cash. Asserting that here rather than assuming it
   * is why `allocate` refuses an over-ceiling external tender instead of
   * clamping it.
   */
  function changeDueCents(sheet) {
    return Math.max(0, allocatedCents(sheet) - sheet.totalCents);
  }

  /** A sale is settled when the tenders cover the bill. */
  function isSettled(sheet) {
    return sheet.totalCents > 0 && allocatedCents(sheet) >= sheet.totalCents;
  }

  /**
   * The most this method may take right now.
   *
   * Cash: unbounded — the customer may hand over a 1,000 note for a 150 bill.
   * Everything else: the remaining balance, because no external or recorded
   * rail can give change at the till.
   */
  function ceilingFor(sheet, methodId) {
    const spec = methodSpec(sheet, methodId);
    if (!spec) return 0;
    if (spec.kind === KIND.CASH) return Infinity;
    /* The balance EXCLUDING this method's own current allocation, so editing an
       existing tender down and back up is not blocked by itself. */
    const mine = (sheet.allocations || [])
      .filter((a) => a.methodId === methodId)
      .reduce((s, a) => s + (Number(a.cents) || 0), 0);
    return Math.max(0, sheet.totalCents - (allocatedCents(sheet) - mine));
  }

  /**
   * Set (not add) this method's allocation. Idempotent per method, so a numpad
   * that fires on every keystroke cannot stack five tenders for one tile.
   *
   * Returns { ok, sheet, error }. It never throws for a user-input problem —
   * a cashier typing too large a number is an ordinary event, not an exception.
   */
  function allocate(sheet, methodId, cents, opts) {
    const spec = methodSpec(sheet, methodId);
    if (!spec) return { ok: false, sheet, error: `"${methodId}" is not available on this till.` };

    let amt = Math.round(Number(cents) || 0);
    if (amt < 0) return { ok: false, sheet, error: 'An amount cannot be negative.' };

    const ceiling = ceilingFor(sheet, methodId);
    if (amt > ceiling) {
      return {
        ok: false, sheet,
        error: spec.kind === KIND.CASH
          ? 'Unexpected cash ceiling.'
          : `${spec.label} cannot exceed the ${fmtKES(ceiling)} still owed — it cannot give change.`,
      };
    }

    const next = Object.assign({}, sheet, {
      allocations: (sheet.allocations || []).filter((a) => a.methodId !== methodId),
    });
    if (amt > 0) {
      next.allocations.push({
        methodId,
        kind:  spec.kind,
        cents: amt,
        ref:   (opts && opts.ref) || null,
        label: spec.label,
      });
    }
    return { ok: true, sheet: next, error: null };
  }

  /** Drop a tender entirely. */
  function remove(sheet, methodId) {
    return Object.assign({}, sheet, {
      allocations: (sheet.allocations || []).filter((a) => a.methodId !== methodId),
    });
  }

  /**
   * THE AUTO-FILL. Put the whole remaining balance on this method.
   *
   * This is what makes the console feel like a till rather than a form: tap
   * Cash, the amount is already there. Tap M-PESA for the rest, that is
   * already there too. The cashier types only when they want something other
   * than the obvious.
   */
  function autoFill(sheet, methodId) {
    const bal = balanceCents(sheet);
    const mine = (sheet.allocations || [])
      .filter((a) => a.methodId === methodId)
      .reduce((s, a) => s + (Number(a.cents) || 0), 0);
    return allocate(sheet, methodId, mine + bal);
  }

  /** Clear every tender, keeping the total and the method list. */
  function reset(sheet) {
    return Object.assign({}, sheet, { allocations: [] });
  }

  /**
   * Can this sale be sent for processing?
   *
   * Deliberately NOT the same question as "is it paid". Every EXTERNAL tender
   * still has to be confirmed by webhookIntasend. This only says the cashier
   * has finished describing how it will be paid.
   */
  function validate(sheet) {
    const problems = [];
    if (!(sheet.totalCents > 0)) problems.push('This sale has no amount.');
    if (!isSettled(sheet)) {
      problems.push(`${fmtKES(balanceCents(sheet))} still to allocate.`);
    }
    for (const a of sheet.allocations || []) {
      const spec = methodSpec(sheet, a.methodId);
      if (spec && spec.needsRef && !a.ref) {
        problems.push(`${spec.label} needs a confirmation code.`);
      }
    }
    /* Change can only come from cash. If the books say otherwise, something
       upstream allowed an external overpay and the sale must not proceed. */
    if (changeDueCents(sheet) > 0 && nonCashCents(sheet) > sheet.totalCents) {
      problems.push('An external tender has overpaid — it cannot give change.');
    }
    return { ok: problems.length === 0, problems };
  }

  /**
   * The payload the till sends onward.
   *
   * `tenders` is always an ARRAY, even for a single cash sale. pos.js's
   * `method: 'split'` was a third value alongside 'cash' and 'mpesa', which
   * meant every downstream reader had to know that one of the three was
   * actually a container — and index.js's receipt path duly grew a special
   * case for it (pos.js:1450). One shape, always.
   */
  function toPayload(sheet) {
    const v = validate(sheet);
    if (!v.ok) return { ok: false, problems: v.problems, payload: null };
    return {
      ok: true,
      problems: [],
      payload: {
        totalCents:  sheet.totalCents,
        changeCents: changeDueCents(sheet),
        tenders: (sheet.allocations || []).map((a) => ({
          methodId: a.methodId,
          kind:     a.kind,
          cents:    a.cents,
          ref:      a.ref || null,
        })),
        /* A single-tender sale still reports its one method, so reporting that
           groups by method does not have to unpack the array to find the
           common case. `mixed` matches what pos-zero-friction already writes. */
        primaryMethod: (sheet.allocations || []).length === 1
          ? sheet.allocations[0].methodId
          : 'mixed',
        /* Which tenders the SERVER must still confirm before this sale is paid.
           The till may never decide this itself. */
        awaitingConfirmation: (sheet.allocations || [])
          .filter((a) => a.kind === KIND.EXTERNAL)
          .map((a) => a.methodId),
      },
    };
  }

  /* ── Capability ─────────────────────────────────────────────────────────
     Which methods a till may offer.

     `capability` is what the server says the IntaSend account has ENABLED. It
     is never guessed here and never cached from a previous shape of the
     account. Absent or unknown ⇒ the always-available set only, so a till with
     no answer sells for cash and Till code rather than showing a customer a
     card button that cannot charge.

     UNKNOWN IS NOT AVAILABLE. That is the whole rule. The probe
     (scripts/probe-intasend-capability.js) reports ENABLED / REFUSED /
     UNKNOWN, and only ENABLED reaches this function. */
  const EXTERNAL_CATALOGUE = Object.freeze({
    'M-PESA':       { id: 'mpesa',      label: 'M-PESA',     icon: '📱' },
    'CARD-PAYMENT': { id: 'card',       label: 'Card',       icon: '💳' },
    'GOOGLE_PAY':   { id: 'google_pay', label: 'Google Pay', icon: '🅖' },
    'APPLE_PAY':    { id: 'apple_pay',  label: 'Apple Pay',  icon: '' },
    'BANK-ACH':     { id: 'bank',       label: 'Bank',       icon: '🏦' },
    'COOP_B2B':     { id: 'pesalink',   label: 'PesaLink',   icon: '🔗' },
    'BITCOIN':      { id: 'bitcoin',    label: 'Bitcoin',    icon: '₿' },
  });

  function methodsFor(capability) {
    const out = ALWAYS_AVAILABLE.slice();
    const enabled = (capability && Array.isArray(capability.enabled)) ? capability.enabled : [];
    for (const code of enabled) {
      const spec = EXTERNAL_CATALOGUE[String(code)];
      /* An unrecognised code is SKIPPED, not rendered with its raw name. A
         button labelled "COOP_B2B_V2" is not a payment method a cashier can
         explain to a customer, and inventing a friendly label for a code we do
         not know would be worse. */
      if (!spec) continue;
      if (out.some((m) => m.id === spec.id)) continue;
      out.push({ id: spec.id, label: spec.label, icon: spec.icon, kind: KIND.EXTERNAL });
    }
    return out;
  }

  /** True when a method needs the customer to act on a device. */
  function needsCustomerDevice(sheet) {
    return (sheet.allocations || []).some((a) => a.kind === KIND.EXTERNAL);
  }

  return {
    KIND, ALWAYS_AVAILABLE, EXTERNAL_CATALOGUE,
    fromShillings, toShillings, fmtKES, fmt,
    createSheet, methodSpec, methodsFor,
    allocate, remove, autoFill, reset,
    allocatedCents, cashCents, nonCashCents, balanceCents, changeDueCents,
    ceilingFor, isSettled, validate, toPayload, needsCustomerDevice,
  };
}));
