'use strict';

/**
 * SOKONI PRODUCT REPORT AUTHORITY
 * ────────────────────────────────────────────────────────────────────────────
 * A report is a complaint about a LISTING. It is not a complaint about an order,
 * it carries no money, and it settles nothing. That separation is the whole point:
 *
 *   REPORT   "this listing should not be on SOKONI"   → moderation    → no money
 *   DISPUTE  "my order went wrong"                    → the warranty  → may end in a refund
 *
 * Keeping them apart matters because they have different claimants (anyone who can see
 * the listing vs. the buyer who paid), different evidence, different windows, and
 * different consequences. Fusing them would let a stranger reach a seller's money, and
 * would let a buyer's refund hinge on a moderation queue.
 *
 * WHAT THE CLIENT MAY SAY
 * ────────────────────────────────────────────────────────────────────────────
 * A reporter supplies exactly three things: which listing, which reason (from a closed
 * list this module owns), and — optionally — a note and references to evidence.
 *
 * A reporter may NOT supply, and this module never reads from the request:
 *   severity · priority · the moderation queue · the seller · the shop · the status ·
 *   whether the listing comes down · whether anyone is penalised or suspended.
 *
 * WHY THE CLOSED LIST EXISTS
 * ────────────────────────────────────────────────────────────────────────────
 * The platform's existing report rail infers severity by keyword-matching the reason
 * string the reporter typed — so a reporter who writes "scam" is filed critical and
 * pages an administrator, while the same complaint written plainly is filed low. That
 * hands the reporter the priority dial.
 *
 * Here a reason is a KEY, not prose, and its severity is a property of the key that this
 * table decides. The note travels for a human to read; it is never classified. Two
 * reporters describing the same problem in different words get the same severity, and no
 * choice of words raises it.
 */

/* ── SEVERITY ────────────────────────────────────────────────────────────────
   Ordered, so "does this outrank that" is an index comparison rather than a pile of
   string equalities that quietly disagree with each other. */
const SEVERITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});
const SEVERITY_ORDER = Object.freeze([SEVERITY.LOW, SEVERITY.MEDIUM, SEVERITY.HIGH, SEVERITY.CRITICAL]);

/* ── THE NINE REASONS ────────────────────────────────────────────────────────
   The complete vocabulary of a product report. `severity` is assigned HERE, by the
   platform, once, for everyone.

   `safety` marks the reasons where the harm continues for as long as the listing is
   up — illegal goods, stolen goods, a listing whose danger is to a person rather than
   to a transaction. It raises queue placement. It does NOT take the listing down: a
   report is an input to moderation, never an instruction to it. */
const REPORT_REASON = Object.freeze({
  misleading: Object.freeze({
    key: 'misleading',
    label: 'Misleading description',
    sw: 'Maelezo ya udanganyifu',
    hint: 'The words do not describe what is actually being sold.',
    severity: SEVERITY.MEDIUM,
    safety: false,
  }),
  not_as_pictured: Object.freeze({
    key: 'not_as_pictured',
    label: "Product doesn't match images",
    sw: 'Bidhaa haifanani na picha',
    hint: 'The photos show something other than the item on sale.',
    severity: SEVERITY.MEDIUM,
    safety: false,
  }),
  counterfeit: Object.freeze({
    key: 'counterfeit',
    label: 'Counterfeit / suspected counterfeit',
    sw: 'Bidhaa bandia',
    hint: 'Sold as a brand it is not.',
    severity: SEVERITY.HIGH,
    safety: false,
  }),
  unsafe: Object.freeze({
    key: 'unsafe',
    label: 'Damaged or unsafe product',
    sw: 'Bidhaa iliyoharibika au hatari',
    hint: 'Expired, tampered with, or a real risk to someone.',
    /* SAFETY. The harm continues for as long as the listing is up, so it is pulled
       forward in the queue — but a report still never removes anything by itself. */
    severity: SEVERITY.CRITICAL,
    safety: true,
  }),
  prohibited: Object.freeze({
    key: 'prohibited',
    label: 'Prohibited or restricted product',
    sw: 'Bidhaa haramu au yenye vizuizi',
    hint: 'Unlawful or restricted to sell.',
    severity: SEVERITY.CRITICAL,
    safety: true,
  }),
  seller_info: Object.freeze({
    key: 'seller_info',
    label: 'Incorrect seller information',
    sw: 'Taarifa za muuzaji si sahihi',
    hint: 'The shop, location or contact details are wrong.',
    severity: SEVERITY.MEDIUM,
    safety: false,
  }),
  fraud: Object.freeze({
    key: 'fraud',
    label: 'Suspicious / fraudulent listing',
    sw: 'Tangazo la kutiliwa shaka',
    hint: 'It looks set up to take money rather than to sell something.',
    severity: SEVERITY.HIGH,
    safety: true,
  }),
  spam: Object.freeze({
    key: 'spam',
    label: 'Duplicate / spam listing',
    sw: 'Tangazo lililorudiwa',
    hint: 'Posted many times, or not a real listing at all.',
    severity: SEVERITY.LOW,
    safety: false,
  }),
  other: Object.freeze({
    key: 'other',
    label: 'Other',
    sw: 'Jambo lingine',
    hint: 'Tell us what is wrong and a person will read it.',
    /* DELIBERATELY THE FLOOR. "Other" is what a reporter picks when none of the named
       reasons fit, so it must never be a way to reach a higher grade than the named
       ones allow. A genuinely serious "other" is raised by the human who reads the
       note, not by the reporter who wrote it. */
    severity: SEVERITY.LOW,
    safety: false,
  }),
});
const REASON_KEYS = Object.freeze(Object.keys(REPORT_REASON));

/* Evidence is REFERENCED, never carried. The request names files that already exist in
   storage; it does not push bytes through a callable, which is how a report endpoint
   turns into an unmetered upload endpoint. */
const EVIDENCE_KIND = Object.freeze(['photo', 'video', 'screenshot', 'document']);
const MAX_EVIDENCE = 6;
const MAX_NOTE = 1000;

/* ── STATUS ──────────────────────────────────────────────────────────────────
   The lifecycle a report may travel, and nothing else. These are the SAME words the
   platform's moderation queue already uses, so a product report and every other report
   share one vocabulary — a second set of status names would mean AdminOS filtering
   "pending" and silently missing half the queue. */
const STATUS = Object.freeze({
  PENDING: 'pending',
  REVIEWING: 'reviewing',
  ACTIONED: 'actioned',
  DISMISSED: 'dismissed',
  ESCALATED: 'escalated',
});

const ALLOWED = Object.freeze({
  [STATUS.PENDING]: Object.freeze([STATUS.REVIEWING, STATUS.ACTIONED, STATUS.DISMISSED, STATUS.ESCALATED]),
  [STATUS.REVIEWING]: Object.freeze([STATUS.ACTIONED, STATUS.DISMISSED, STATUS.ESCALATED]),
  [STATUS.ESCALATED]: Object.freeze([STATUS.ACTIONED, STATUS.DISMISSED]),
  /* Terminal. Re-opening a decided report would rewrite a moderator's record; a new
     complaint is a new report, with its own evidence and its own moment in time. */
  [STATUS.ACTIONED]: Object.freeze([]),
  [STATUS.DISMISSED]: Object.freeze([]),
});

const OPEN_STATUSES = Object.freeze([STATUS.PENDING, STATUS.REVIEWING, STATUS.ESCALATED]);

function refuse(reason, detail) {
  return { ok: false, reason, detail: detail || null };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function text(v, max) {
  if (typeof v !== 'string') return '';
  /* Trimmed and capped only. NOT html-escaped here: escaping at the authority would
     store `&amp;` as if the reporter had typed it, and every later reader — a CSV
     export, an email to a moderator, a second escape on render — would see the damage.
     Escaping belongs at the surface that renders. */
  return v.trim().slice(0, max);
}

/* ── 1. THE REASON ───────────────────────────────────────────────────────────
   The only place a report's severity is decided. */
function classify(reasonKey) {
  const key = typeof reasonKey === 'string' ? reasonKey.trim() : '';
  if (!key) return refuse('NO_REASON');
  const r = REPORT_REASON[key];
  /* An unknown key is REFUSED, not defaulted to `other`. A client sending a reason this
     module has never heard of is a client running against a different vocabulary — and
     quietly filing it as "something else" would lose the complaint the reporter
     actually made while telling them it was received. */
  if (!r) return refuse('UNKNOWN_REASON', key);
  return { ok: true, key: r.key, label: r.label, severity: r.severity, safety: r.safety };
}

/* ── 2. WHAT A REPORTER MAY SEND ─────────────────────────────────────────────
   Validates the shape and returns the NORMALISED payload a caller may persist. Anything
   the request carried that is not named here is dropped rather than merged: a request
   that can add fields to a moderation document is a request that can set its own
   status. */
function validateReport(input) {
  const i = isPlainObject(input) ? input : {};

  const productId = text(i.productId, 200);
  if (!productId) return refuse('NO_PRODUCT');

  const cls = classify(i.reason);
  if (!cls.ok) return cls;

  const note = text(i.note, MAX_NOTE);
  /* "Something else" carries no meaning without the words. Every other reason names
     itself, so a note there is welcome but optional. */
  if (cls.key === 'other' && note.length < 10) {
    return refuse('NOTE_REQUIRED', 'Tell us briefly what is wrong.');
  }

  const rawEvidence = Array.isArray(i.evidence) ? i.evidence : [];
  if (rawEvidence.length > MAX_EVIDENCE) return refuse('TOO_MUCH_EVIDENCE', String(MAX_EVIDENCE));
  const evidence = [];
  for (const e of rawEvidence) {
    if (!isPlainObject(e)) return refuse('BAD_EVIDENCE');
    const kind = text(e.kind, 20);
    const path = text(e.path, 500);
    if (EVIDENCE_KIND.indexOf(kind) === -1) return refuse('BAD_EVIDENCE_KIND', kind);
    if (!path) return refuse('BAD_EVIDENCE_PATH');
    evidence.push({ kind, path });
  }

  return {
    ok: true,
    report: {
      productId,
      reason: cls.key,
      note: note || null,
      evidence,
      /* SERVER-DECIDED, echoed here so the caller persists the authority's answer rather
         than recomputing one of its own. */
      severity: cls.severity,
      safety: cls.safety,
    },
  };
}

/* ── 3. WHERE IT GOES ────────────────────────────────────────────────────────
   Queue placement, decided from the severity this module assigned — never from the
   request, and never from the reporter's prose. */
function moderationRouting(severity, opts) {
  const o = isPlainObject(opts) ? opts : {};
  const at = SEVERITY_ORDER.indexOf(severity);
  if (at === -1) return refuse('UNKNOWN_SEVERITY', String(severity));

  const safety = o.safety === true;
  /* Priority 1 is the top of the queue. A safety reason is pulled forward one place
     because the harm continues while the listing is up — but it stops at 1 and cannot
     wrap around into 0 or a negative, which would sort ahead of a genuine critical. */
  const base = SEVERITY_ORDER.length - at;
  const priority = Math.max(1, safety ? base - 1 : base);

  return {
    ok: true,
    queue: 'moderation',
    priority,
    /* Only a critical report wakes a human immediately. If everything paged, nothing
       would. */
    notifyAdmin: severity === SEVERITY.CRITICAL,
    /* THE LOAD-BEARING ZERO. A report never removes a listing, never suspends a seller
       and never withholds money, no matter how many arrive or how severe they are.
       Moderation acts; reporting only informs. A count that could act on its own would
       make brigading a weapon. */
    autoAction: null,
  };
}

/* ── 4. ONE REPORTER, ONE REPORT ─────────────────────────────────────────────
   The document id, derived so that a double-tapped button, a retried request and a
   flaky connection all land on the SAME document instead of three.

   The reporter's uid is hashed rather than written into the key: the id appears in
   moderation lists and audit exports, and a seller who ever glimpsed one should not be
   able to read the reporter's identity out of it. */
function reportKey(productId, reporterUid, hasher) {
  const p = text(productId, 200);
  const u = text(reporterUid, 200);
  if (!p || !u) return refuse('NO_KEY_INPUTS');
  if (typeof hasher !== 'function') return refuse('NO_HASHER');
  const digest = String(hasher('sokoni-product-report-v1|' + p + '|' + u));
  if (!digest) return refuse('NO_DIGEST');
  return { ok: true, id: 'prd_' + digest.slice(0, 40) };
}

/* ── 5. THE MODERATOR'S MOVE ─────────────────────────────────────────────────
   Which transitions exist. Whether the person asking is allowed to make one is an
   authorisation question, answered by the caller against its own claims — this module
   answers only "is that a legal move". */
function canTransition(from, to) {
  const f = text(from, 40);
  const t = text(to, 40);
  if (!ALLOWED[f]) return refuse('UNKNOWN_STATUS', f);
  if (!STATUS[String(t).toUpperCase()] && ALLOWED[t] === undefined) return refuse('UNKNOWN_TARGET', t);
  if (ALLOWED[f].indexOf(t) === -1) return refuse('ILLEGAL_TRANSITION', f + '->' + t);
  return { ok: true, from: f, to: t, terminal: ALLOWED[t].length === 0 };
}

/* ── 6. WHAT THE SELLER IS ALLOWED TO SEE ────────────────────────────────────
   A seller must know a listing has been reported — they cannot fix what they cannot
   see. They must NOT learn who reported it.
 *
 * Withheld, deliberately: the reporter's identity, their note, their evidence, and the
 * moderator's internal resolution. The note and the evidence are withheld because they
 * routinely identify the reporter by their content even when the uid is stripped —
 * "I bought this on Tuesday and.." names one person to a seller who has the order list.
 */
function sellerView(report) {
  const r = isPlainObject(report) ? report : {};
  const cls = classify(r.reason);
  return {
    id: r.id || null,
    productId: r.productId || null,
    reason: cls.ok ? cls.key : null,
    reasonLabel: cls.ok ? cls.label : null,
    severity: cls.ok ? cls.severity : null,
    status: r.status || null,
    createdAt: r.createdAt || null,
    /* The outcome, once there is one, because it is the part a seller can act on. */
    outcome: (r.status === STATUS.ACTIONED || r.status === STATUS.DISMISSED) ? r.status : null,
  };
}

/* Proves the projection above by CONSTRUCTION rather than by inspection: whatever the
   stored document happens to contain, these keys must never reach a seller. Used by the
   suite, and by anyone tempted to add a field to sellerView. */
const SELLER_FORBIDDEN = Object.freeze([
  'reportedBy', 'reporterUid', 'note', 'detail', 'evidence',
  'resolution', 'adminNotes', 'reviewedBy',
]);

/* NOT REPORT REASONS. These describe a purchase, not a listing, and belong to the
   dispute rail — which knows the order, the warranty pinned to it and the way back to
   the buyer's money. A listing report can do none of that, so offering these here
   would route a refund claim into a moderation queue and lose it. */
const NOT_A_LISTING_REASON = Object.freeze([
  'not_received', 'wrong_item', 'damaged', 'defective', 'not_as_described', 'overcharged',
]);

module.exports = {
  SEVERITY, SEVERITY_ORDER, REPORT_REASON, REASON_KEYS,
  NOT_A_LISTING_REASON,
  EVIDENCE_KIND, MAX_EVIDENCE, MAX_NOTE,
  STATUS, ALLOWED, OPEN_STATUSES, SELLER_FORBIDDEN,
  classify, validateReport, moderationRouting, reportKey, canTransition, sellerView,
};
