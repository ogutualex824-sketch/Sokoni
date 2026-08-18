/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Disputes — the client layer (2D-2 step 4)

   Four authorities, and the boundaries between them are the whole design:

       getSellerDisputes      list   — disputes where sellerId == the caller
       getDisputeDetail       read   — buyer, seller or admin only
       sellerRespondToDispute write  — SELLER only; sets status seller_responded
       addDisputeEvidence     write  — either party, while the dispute is open

   ── What a merchant CANNOT do, and why the screen must say so ───────────────
   · OPEN a dispute. `createDispute` rejects anyone who is not the buyer on the
     order (`isBuyer` check). Disputes start from the buyer's order, and a
     merchant reaching for a "raise a dispute" button would be reaching for a
     call the server refuses. The surface explains the route instead.
   · CANCEL one. `cancelDispute` is the BUYER withdrawing their own claim
     (`data.buyerId !== uid` → denied). It is not a merchant action, despite
     reading like one.
   · RESOLVE one. `adminResolveDispute` is admin-gated, correctly. A merchant
     responds; SOKONI decides. Nothing here may imply otherwise.

   ── Scope: this is ACCOUNT-level, and it is not dressed up as shop-level ────
   A dispute document carries `orderId`, `buyerId` and `sellerId` — and **no
   `shopId`**. `sellerId` is copied from the ORDER (`order.sellerId ||
   order.vendorId`), so it is an account uid. `getSellerDisputes` therefore
   queries `sellerId == auth.uid`: everything this account sells, across every
   shop it owns.

   Filtering by `activeShopId` on the client would be a lie in either direction —
   it would hide real disputes if the field were absent, and invent a shop
   boundary the server never applied. `scopeNote()` returns the honest statement
   so the surface can show it, exactly as Marketing does for Ads.

   ── No Firestore access ─────────────────────────────────────────────────────
   None, and it could not help anyway: `firestore.rules` gates a seller's read on
   `resource.data.sellerUid`, a field disputes never carry (the code writes
   `sellerId`). The client-SDK read path for a seller is dead; the callables are
   the only way in. Recorded, not worked around.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantDisputes = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CALLABLES = {
    list: 'getSellerDisputes',
    detail: 'getDisputeDetail',
    respond: 'sellerRespondToDispute',
    evidence: 'addDisputeEvidence',
  };

  /* Mirrors OPEN_STATUSES in functions/disputes.js. A dispute outside this set
     is closed to both parties — the server refuses evidence and responses. */
  var OPEN_STATUSES = ['open', 'investigating', 'seller_responded'];

  var STATUS_LABELS = {
    open:              { label: 'Awaiting your response', tone: 'action' },
    investigating:     { label: 'SOKONI is reviewing',    tone: 'wait' },
    seller_responded:  { label: 'Awaiting SOKONI review', tone: 'wait' },
    resolved:          { label: 'Resolved by SOKONI',     tone: 'done' },
    cancelled:         { label: 'Withdrawn by the buyer', tone: 'done' },
    closed:            { label: 'Closed',                 tone: 'done' },
  };

  var REASON_LABELS = {
    not_received:     'Item never arrived',
    wrong_item:       'Wrong item sent',
    not_as_described: 'Not as described',
    damaged:          'Arrived damaged',
    late_delivery:    'Delivered late',
    other:            'Other',
  };

  /* Evidence a merchant can realistically produce. `evidenceType` is a free
     string server-side (capped at 60 chars), so this list is the SURFACE's
     vocabulary, not a server contract — stated so nobody mistakes it for one. */
  var EVIDENCE_TYPES = [
    { id: 'proof_of_delivery', label: 'Proof of delivery', hint: 'A signature, photo or tracking record' },
    { id: 'photo',             label: 'Photo of the item', hint: 'What was actually sent' },
    { id: 'receipt',           label: 'Receipt or invoice', hint: 'What the customer paid for' },
    { id: 'communication',     label: 'Messages with the buyer', hint: 'What was agreed' },
    { id: 'other',             label: 'Something else',     hint: 'Explain below' },
  ];

  function isOpen(status) { return OPEN_STATUSES.indexOf(String(status)) !== -1; }
  function statusInfo(status) {
    return STATUS_LABELS[String(status)] || { label: String(status || 'Unknown'), tone: 'wait' };
  }
  function reasonLabel(r) { return REASON_LABELS[String(r)] || String(r || '—'); }

  /* The honest description of what the list contains. */
  function scopeNote() {
    return {
      level: 'account',
      label: 'Disputes across your account',
      note: 'Disputes are raised against an order, not against one shop, so this list covers ' +
            'everything sold under your SOKONI account.',
    };
  }

  /* What a merchant may do to THIS dispute, decided from the dispute itself —
     never from the surface's own idea of what buttons look useful. */
  function permissions(d) {
    var open = isOpen(d && d.status);
    return {
      canRespond: open && !(d && d.sellerResponse),
      canAddEvidence: open,
      /* Stated as false so the surface can render the explanation rather than
         simply omitting the control and leaving a merchant wondering. */
      canOpen: false,
      canCancel: false,
      canResolve: false,
    };
  }

  function _unwrap(res) { return (res && res.data) ? res.data : res; }

  async function _call(fn, payload, failMessage) {
    if (typeof fn !== 'function') throw new Error('merchant disputes: callable is required');
    try {
      var d = _unwrap(await fn(payload));
      if (d && d.ok === false) return { ok: false, error: d.error || failMessage };
      return Object.assign({ ok: true }, d || {});
    } catch (e) {
      return { ok: false, error: (e && e.message) || failMessage, code: (e && e.code) || null };
    }
  }

  /* ── List ─────────────────────────────────────────────────────────────────
     The server already scopes to sellerId == caller. Nothing is filtered by shop
     here: see the header. Open disputes sort first, because those are the ones
     with a deadline attached to them. */
  function projectDispute(d) {
    return {
      id: d.id || d.disputeId || null,
      orderId: d.orderId || null,
      reason: d.reason || null,
      description: d.description || '',
      status: d.status || 'open',
      amount: (typeof d.amount === 'number') ? d.amount : null,
      sellerResponse: d.sellerResponse || null,
      evidence: Array.isArray(d.evidence) ? d.evidence : [],
      timeline: Array.isArray(d.timeline) ? d.timeline : [],
      createdAt: d.createdAt || null,
    };
  }

  async function listDisputes(o) {
    var r = await _call(o.callList, {}, 'Your disputes could not be loaded.');
    if (!r.ok) return r;
    var rows = (r.disputes || []).map(projectDispute);
    rows.sort(function (a, b) {
      var ao = isOpen(a.status) ? 0 : 1, bo = isOpen(b.status) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      var at = (a.createdAt && a.createdAt.seconds) || 0;
      var bt = (b.createdAt && b.createdAt.seconds) || 0;
      return bt - at;
    });
    return { ok: true, disputes: rows, count: rows.length, openCount: rows.filter(function (x) { return isOpen(x.status); }).length };
  }

  async function getDetail(o) {
    if (!o.disputeId) throw new Error('merchant disputes: disputeId is required');
    var r = await _call(o.callDetail, { disputeId: String(o.disputeId) }, 'That dispute could not be loaded.');
    if (!r.ok) return r;
    return { ok: true, dispute: projectDispute(r.dispute || r) };
  }

  /* ── Respond ──────────────────────────────────────────────────────────────
     Sets status to `seller_responded`, which is NOT a resolution. The surface
     must say "awaiting SOKONI review" — a merchant who believes they have closed
     the matter will stop watching it. */
  function buildResponse(o) {
    if (!o.disputeId) throw new Error('merchant disputes: disputeId is required');
    var text = String(o.response == null ? '' : o.response).trim();
    if (text.length < 10) throw new Error('Explain what happened — at least a sentence.');
    return { disputeId: String(o.disputeId), response: text.slice(0, 2000) };
  }

  async function respond(o) {
    return _call(o.callRespond, buildResponse(o), 'Your response could not be sent.');
  }

  /* ── Evidence ─────────────────────────────────────────────────────────────
     `fileUrl` is optional and is sent only when present; the server stores it as
     a plain string, so a missing attachment must not become an empty one. */
  function buildEvidence(o) {
    if (!o.disputeId) throw new Error('merchant disputes: disputeId is required');
    var type = String(o.evidenceType || '');
    if (!type) throw new Error('Choose what kind of evidence this is.');
    var desc = String(o.description == null ? '' : o.description).trim();
    if (desc.length < 5) throw new Error('Describe the evidence briefly.');
    var p = { disputeId: String(o.disputeId), evidenceType: type, description: desc.slice(0, 1000) };
    if (o.fileUrl) p.fileUrl = String(o.fileUrl).slice(0, 2000);
    return p;
  }

  async function addEvidence(o) {
    return _call(o.callEvidence, buildEvidence(o), 'The evidence could not be added.');
  }

  function evidenceLabel(id) {
    for (var i = 0; i < EVIDENCE_TYPES.length; i++) if (EVIDENCE_TYPES[i].id === id) return EVIDENCE_TYPES[i].label;
    return id || 'Evidence';
  }

  /* Money is never invented: an unknown amount is a dash, not zero. */
  function formatKES(n) {
    if (n == null || (typeof n === 'number' && !isFinite(n))) return '—';
    return 'KES ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 });
  }

  return {
    CALLABLES: CALLABLES,
    OPEN_STATUSES: OPEN_STATUSES,
    STATUS_LABELS: STATUS_LABELS,
    EVIDENCE_TYPES: EVIDENCE_TYPES,
    isOpen: isOpen,
    statusInfo: statusInfo,
    reasonLabel: reasonLabel,
    scopeNote: scopeNote,
    permissions: permissions,
    projectDispute: projectDispute,
    listDisputes: listDisputes,
    getDetail: getDetail,
    buildResponse: buildResponse,
    respond: respond,
    buildEvidence: buildEvidence,
    addEvidence: addEvidence,
    evidenceLabel: evidenceLabel,
    formatKES: formatKES,
  };
}));
