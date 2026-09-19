/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — INVOICE DESK
   sokoni-invoice-desk.js

   The invoice workspace, built on what `invoiceList` actually returns and on what
   `invoiceCreate` actually writes.

   ── WHY THIS IS NOT AN ADMIN PAGE ───────────────────────────────────────────────────────
   Every invoice callable — list, get, create, send, markPaid, void — takes a `shopId` and
   calls `_assertShop(uid, shopId)` (void requires `_assertShopManager`). They are SHOP
   authority, not platform authority. There is no admin invoice list callable anywhere in
   `functions/`, so an AdminOS "Invoices" section could not be fed without minting a new
   admin-scoped read — a new callable, a deploy, and a decision about whether platform
   operators may read every merchant's billing. None of those is a styling task.

   So this desk mounts on the surface that already holds the contract, `finance-invoices.html`,
   and the three writes stay exactly where they were.

   ── THE DOCUMENT, READ RATHER THAN ASSUMED ──────────────────────────────────────────────
   `invoiceCreate` writes, and `invoiceList` returns:

       id · shopId · invoiceNumber · clientName · clientEmail · clientPhone
       items[{description, quantity, unitPrice, total}] · subtotal · taxRate · tax · total
       currency · notes · dueDate · status · sentAt · paidAt · voidedAt
       paymentRef · paymentMethod · createdBy · createdAt · updatedAt

   plus `isOverdue`, which the SERVER derives — and only for `status === 'sent'`.

   ── TWO CONTRACT DEFECTS THIS DESK DOES NOT HIDE ────────────────────────────────────────
   1. THE PAGE IS NOT "THE MOST RECENT". The query is
        .where('shopId','==',shopId).limit(100)
      with NO orderBy. Firestore returns an arbitrary hundred, and the handler sorts them
      by createdAt AFTERWARDS. So the newest invoice may not be on the page at all, and a
      desk that called this "latest invoices" would be asserting something the query does
      not provide. The note says what it is: a page, then sorted.

   2. THE STATUS FILTER RUNS AFTER THE CAP. `status` is applied with `.filter()` on the
      hundred already fetched, not as a `where`. Asking for "paid" therefore returns the
      paid invoices WITHIN that arbitrary page — never the shop's paid invoices. Filtering
      here is done client-side for the same reason, over the same page, so the two cannot
      disagree; what would be dishonest is presenting either as a complete answer.

   ── SETTLEMENT IS BINARY ────────────────────────────────────────────────────────────────
   `invoiceMarkPaid` sets `status: 'paid'` in one transaction. There is no payment ledger,
   no partial application, no credit note. An invoice's outstanding amount is therefore its
   total or nothing — never a remainder. A "Balance Due" column implying partial settlement
   would invent an accounts-receivable model this platform does not have, so the column is
   named Outstanding and the note says why it can only ever hold two values.

   ── WHAT THIS PLATFORM DOES NOT RECORD ──────────────────────────────────────────────────
   Declared with reasons and asserted absent by `scripts/test-invoice-desk.js`:

     • NO TRENDS. "↑12.4% vs last 30 days" needs a prior period. Nothing returns one.
     • NO PLATFORM TOTAL. One shop, capped, arbitrary page.
     • NO CARD BRANDS. `paymentMethod` defaults to 'mpesa'; there is no card rail, no ACH,
       and no last four digits on an invoice.
     • NO RECURRENCE. There is no field making an invoice Monthly or One-time, and no
       schedule behind it. `generateMonthlyInvoices` is a different collection's concern.
     • NO BILLING PERIOD, NO PURCHASE ORDER. Neither field exists on the document.
     • NO ATTACHMENTS. `invoiceSend` emails the client; nothing records a stored PDF.
     • NO FOREIGN CURRENCY DEFAULT. `currency` defaults to KES and figures render in the
       currency the document carries — never USD because a mockup said so.

   ── AGING IS REAL ───────────────────────────────────────────────────────────────────────
   Unlike the above, an aging summary IS derivable: `dueDate` and `status` are both present,
   so open invoices bucket into 0-30 / 31-60 / 61-90 / 91+ days past due. It is computed
   over the loaded page and says so. Days-to-pay is likewise real — `paidAt - createdAt` on
   settled invoices — while its month-on-month change is not, and is absent.

   ADDITIVE. Renders into the existing #invoiceList host; returns false if it cannot, leaving
   the original card list to run. It performs no read and no write of its own — send, mark
   paid and void delegate to the handlers this page already owns.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var CSS_ID = 'sokoni-invoice-desk-css';
  var DAY = 86400000;

  function esc (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ms (t) {
    if (!t) return null;
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (t.seconds) return t.seconds * 1000;
    if (t._seconds) return t._seconds * 1000;
    var n = typeof t === 'number' ? t : Date.parse(t);
    return isFinite(n) ? n : null;
  }
  function when (t) {
    var m = ms(t);
    return m ? new Date(m).toLocaleDateString('en-KE',
      { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  }
  function num (v) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : null;
  }
  function cur (inv) { return inv && inv.currency ? String(inv.currency) : 'KES'; }
  function fmt (amount, c) {
    return (c || 'KES') + ' ' + Number(amount).toLocaleString('en-KE', { maximumFractionDigits: 2 });
  }

  /* ── STATUS ─────────────────────────────────────────────────────────────────
     Exactly the four `invoiceCreate` / `invoiceMarkPaid` / `invoiceVoid` write. "Open" is
     not a status here — a sent invoice is `sent`, and calling it something else on screen
     would put a fifth word into a four-word vocabulary. */
  var STATUSES = [
    { id: 'draft', label: 'Draft', tone: 'muted' },
    { id: 'sent',  label: 'Sent',  tone: 'info' },
    { id: 'paid',  label: 'Paid',  tone: 'ok' },
    { id: 'void',  label: 'Void',  tone: 'bad' },
  ];
  function statusTone (s) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].id === s) return STATUSES[i].tone;
    return 'muted';
  }
  function statusOf (inv) { return String(inv.status || '').toLowerCase() || 'not recorded'; }

  /* SETTLED / OPEN / VOID. `void` is neither owed nor collected, so it is excluded from
     every money figure rather than being counted as zero revenue. */
  function isPaid (inv) { return statusOf(inv) === 'paid'; }
  function isVoid (inv) { return statusOf(inv) === 'void'; }
  function isOpen (inv) { return !isPaid(inv) && !isVoid(inv); }

  /* OVERDUE, exactly as the server derives it: sent, dated, and past due. A DRAFT past its
     due date is deliberately NOT overdue — nothing has been claimed from the client yet,
     and the server does not flag it either. Re-deriving it differently here would make the
     screen disagree with the record. */
  function overdueDays (inv, now) {
    if (statusOf(inv) !== 'sent') return null;
    var d = ms(inv.dueDate);
    if (!d) return null;
    var days = Math.floor(((now || Date.now()) - d) / DAY);
    return days > 0 ? days : null;
  }
  function daysToPay (inv) {
    if (!isPaid(inv)) return null;
    var a = ms(inv.createdAt), b = ms(inv.paidAt);
    if (!a || !b || b < a) return null;
    return Math.round((b - a) / DAY);
  }

  /* AGING over the OPEN invoices of the loaded page. Real: both inputs exist. */
  var BUCKETS = [
    { id: 'cur', label: 'Current', sub: 'not yet due', lo: -Infinity, hi: 0 },
    { id: 'b30', label: '1–30 days', sub: 'past due', lo: 1, hi: 30 },
    { id: 'b60', label: '31–60 days', sub: 'past due', lo: 31, hi: 60 },
    { id: 'b90', label: '61–90 days', sub: 'past due', lo: 61, hi: 90 },
    { id: 'b91', label: '91+ days', sub: 'past due', lo: 91, hi: Infinity },
  ];

  function render (host, state) {
    var invoices = state.invoices;
    var now = state.now || Date.now();

    var byStatus = {};
    invoices.forEach(function (i) {
      var s = statusOf(i);
      byStatus[s] = (byStatus[s] || 0) + 1;
    });

    /* Money is only summed where a total is actually recorded, and only within ONE
       currency — adding KES to anything else would produce a number that means nothing. */
    var currencies = {};
    invoices.forEach(function (i) { if (num(i.total) !== null) currencies[cur(i)] = true; });
    var curList = Object.keys(currencies);
    var mixed = curList.length > 1;
    var C = curList[0] || 'KES';

    var sumOf = function (rows) {
      var any = false, t = 0;
      rows.forEach(function (i) {
        var v = num(i.total);
        if (v !== null) { t += v; any = true; }
      });
      return any ? t : null;
    };
    var moneyCell = function (v) {
      if (mixed) return 'mixed';
      return v === null ? '&mdash;' : esc(fmt(v, C));
    };

    var openRows = invoices.filter(isOpen);
    var paidRows = invoices.filter(isPaid);
    var overdueRows = invoices.filter(function (i) { return overdueDays(i, now) !== null; });

    var invoiced = sumOf(invoices.filter(function (i) { return !isVoid(i); }));
    var collected = sumOf(paidRows);
    var outstanding = sumOf(openRows);
    var overdueAmt = sumOf(overdueRows);

    var payDays = invoices.map(daysToPay).filter(function (d) { return d !== null; });
    var avgPay = payDays.length
      ? Math.round(payDays.reduce(function (a, b) { return a + b; }, 0) / payDays.length)
      : null;

    /* AGING — over the invoices that have actually been CLAIMED: sent, unsettled and
       dated. Drafts are excluded deliberately. A draft past its due date would otherwise
       land in a past-due bucket while the Overdue figure above ignored it, and the two
       blocks would disagree by exactly that invoice with nothing on screen to explain it.
       Both now use one rule — the server's — and what is excluded is stated. */
    var ageable = openRows.filter(function (i) { return statusOf(i) === 'sent'; });
    var aging = BUCKETS.map(function (b) {
      var rows = ageable.filter(function (i) {
        var d = ms(i.dueDate);
        if (!d) return false;
        var days = Math.floor((now - d) / DAY);
        return days >= b.lo && days <= b.hi;
      });
      return { def: b, n: rows.length, amount: sumOf(rows) };
    });
    var agingTotal = aging.reduce(function (a, x) { return a + (x.amount || 0); }, 0);
    var undated = ageable.filter(function (i) { return !ms(i.dueDate); }).length;
    var draftsOpen = openRows.filter(function (i) { return statusOf(i) !== 'sent'; }).length;

    var can = state.can || {};

    var visible = invoices.filter(function (i) {
      /* "Overdue" is DERIVED, not stored — it is `sent` plus a past due date — so the tab
         filters on the predicate rather than pretending there is a fifth status. */
      if (state.status === 'overdue') { if (overdueDays(i, now) === null) return false; }
      else if (state.status !== 'all' && statusOf(i) !== state.status) return false;
      if (!state.q) return true;
      return ((i.invoiceNumber || '') + ' ' + (i.clientName || '') + ' ' +
              (i.clientEmail || '') + ' ' + (i.paymentRef || '') + ' ' + (i.id || ''))
        .toLowerCase().indexOf(state.q) > -1;
    });

    var stat = function (label, v, t, sub) {
      return '<div class="ivx-stat ivx-stat--' + t + '">' +
        '<div class="ivx-stat-n">' + v + '</div>' +
        '<div class="ivx-stat-l">' + esc(label) + '</div>' +
        '<div class="ivx-stat-s">' + esc(sub) + '</div></div>';
    };

    var open = state.open
      ? invoices.filter(function (i) { return String(i.id) === state.open; })[0] : null;

    host.innerHTML =
      '<div class="ivx">' +

      /* ── STRIP ───────────────────────────────────────────────────────────── */
      '<div class="ivx-strip">' +
        stat('Loaded', invoices.length, 'info', 'this page, not a shop total') +
        stat('Invoiced', moneyCell(invoiced), 'info', 'voided excluded, of those loaded') +
        stat('Collected', moneyCell(collected), 'ok', paidRows.length + ' settled in full') +
        stat('Outstanding', moneyCell(outstanding), 'warn', openRows.length + ' unsettled') +
        stat('Overdue', moneyCell(overdueAmt), 'bad', overdueRows.length + ' sent and past due') +
        stat('Avg days to pay', avgPay === null ? '&mdash;' : avgPay, 'info',
             payDays.length ? 'mean of ' + payDays.length + ' settled'
                            : 'no settled invoice on this page') +
      '</div>' +

      /* ── AGING ───────────────────────────────────────────────────────────── */
      '<div class="ivx-aging">' +
        '<div class="ivx-aging-h"><b>Aging</b>' +
          '<span>sent, unsettled invoices on this page, by days past due' +
            (undated ? ' · ' + undated + ' with no due date not bucketed' : '') +
            (draftsOpen ? ' · ' + draftsOpen + ' unsent draft' + (draftsOpen === 1 ? '' : 's') +
                          ' excluded, nothing has been claimed yet' : '') + '</span>' +
        '</div>' +
        (agingTotal > 0 && !mixed
          ? '<div class="ivx-aging-bar">' +
              aging.map(function (a) {
                var pc = a.amount ? (a.amount / agingTotal) * 100 : 0;
                return pc > 0 ? '<span class="ivx-seg ivx-seg--' + a.def.id +
                  '" style="width:' + pc.toFixed(2) + '%" title="' + esc(a.def.label) + '"></span>' : '';
              }).join('') +
            '</div>'
          : '') +
        '<div class="ivx-aging-g">' +
          aging.map(function (a) {
            return '<div class="ivx-age ivx-age--' + a.def.id + '">' +
              '<div class="ivx-age-n">' + moneyCell(a.amount) + '</div>' +
              '<div class="ivx-age-l">' + esc(a.def.label) + '</div>' +
              '<div class="ivx-age-s">' + a.n + ' invoice' + (a.n === 1 ? '' : 's') +
                ' · ' + esc(a.def.sub) + '</div>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>' +

      /* ── TABS ────────────────────────────────────────────────────────────── */
      '<div class="ivx-tabs">' +
        '<button class="ivx-tab' + (state.status === 'all' ? ' is-on' : '') +
          '" data-ivx="status" data-v="all">All <span>' + invoices.length + '</span></button>' +
        STATUSES.map(function (s) {
          return byStatus[s.id]
            ? '<button class="ivx-tab' + (state.status === s.id ? ' is-on' : '') +
              '" data-ivx="status" data-v="' + s.id + '">' + s.label +
              ' <span>' + byStatus[s.id] + '</span></button>'
            : '';
        }).join('') +
        (overdueRows.length
          ? '<button class="ivx-tab ivx-tab--bad' + (state.status === 'overdue' ? ' is-on' : '') +
            '" data-ivx="status" data-v="overdue">Overdue <span>' + overdueRows.length +
            '</span></button>'
          : '') +
      '</div>' +

      /* ── TOOLBAR ─────────────────────────────────────────────────────────── */
      '<div class="ivx-tools">' +
        '<input class="ivx-in" type="search" placeholder="Filter loaded invoices…" ' +
          'value="' + esc(state.qRaw || '') + '" data-ivx="q" aria-label="Filter invoices">' +
        '<span class="ivx-showing">' + visible.length + ' of ' + invoices.length + ' shown</span>' +
      '</div>' +

      /* ── TABLE ───────────────────────────────────────────────────────────── */
      (visible.length
        ? '<div class="ivx-tw"><table class="ivx-t"><thead><tr>' +
            '<th>Invoice</th><th>Client</th><th>Status</th><th>Due</th>' +
            '<th class="ivx-r">Total</th><th class="ivx-r">Outstanding</th><th>Settled by</th><th></th>' +
          '</tr></thead><tbody>' +
          visible.map(function (i) {
            var id = String(i.id || '');
            var s = statusOf(i);
            var od = overdueDays(i, now);
            var t = num(i.total);
            var d = when(i.dueDate);
            return '<tr' + (state.open === id ? ' class="is-open"' : '') +
                   (od ? ' class="is-late"' : '') + ' data-ivx="open" data-id="' + esc(id) + '">' +
              '<td><div class="ivx-no">' + esc(i.invoiceNumber || 'no number') + '</div>' +
                '<small>' + (when(i.createdAt) ? 'raised ' + esc(when(i.createdAt))
                                               : 'no creation date') + '</small></td>' +
              '<td><div class="ivx-cl">' + esc(i.clientName || 'no client recorded') + '</div>' +
                (i.clientEmail ? '<small>' + esc(i.clientEmail) + '</small>' : '') + '</td>' +
              '<td><span class="ivx-st ivx-st--' + statusTone(s) + '">' + esc(s) + '</span>' +
                (od ? '<span class="ivx-late">' + od + 'd late</span>' : '') + '</td>' +
              '<td class="ivx-dim">' + (d ? esc(d) : 'no due date') + '</td>' +
              '<td class="ivx-r">' + (t === null ? '<span class="ivx-dim">not recorded</span>'
                                                 : esc(fmt(t, cur(i)))) + '</td>' +
              /* Binary by construction: the full total, or nothing at all. */
              '<td class="ivx-r' + (isOpen(i) && t !== null ? ' ivx-owed' : ' ivx-dim') + '">' +
                (isVoid(i) ? 'voided'
                  : isPaid(i) ? 'settled'
                  : t === null ? 'not recorded' : esc(fmt(t, cur(i)))) + '</td>' +
              '<td class="ivx-dim">' +
                (isPaid(i)
                  ? esc(i.paymentMethod || 'method not recorded') +
                    (i.paymentRef ? '<small>' + esc(i.paymentRef) + '</small>' : '')
                  : '&mdash;') + '</td>' +
              '<td class="ivx-r"><button class="ivx-btn sm" data-ivx="open" data-id="' + esc(id) +
                '">View</button></td>' +
            '</tr>';
          }).join('') +
          '</tbody></table></div>'
        : '<div class="ivx-none"><b>' +
            (invoices.length ? 'No loaded invoice matches this filter' : 'No invoices returned') +
          '</b><span>' + (invoices.length ? 'Clear the filter or choose another status.'
            : 'This shop returned an empty page.') + '</span></div>') +

      (open ? detail(open, can, now) : '') +

      /* ── WHAT THIS DESK IS AND IS NOT ────────────────────────────────────── */
      '<div class="ivx-note">' +
        '<b>About this page.</b> The read is <b>capped and unordered</b> — it asks for ' +
        'invoices of this shop with a limit and no sort, then sorts what came back. So this ' +
        'is <b>a page of ' + invoices.length + ' invoices, then sorted</b>, not the newest ' +
        ers(invoices.length) + '. A status filter is applied to the same page, so it shows ' +
        'the matching invoices <i>on this page</i> and never the shop\'s full set. Every ' +
        'figure above is of these ' + invoices.length + ' only, and there is no ' +
        'month-on-month change because no prior-period figure exists.' +
      '</div>' +
      '<div class="ivx-note">' +
        '<b>Settlement is all-or-nothing.</b> Marking an invoice paid sets its status in one ' +
        'step — there is no payment ledger and no partial application — so Outstanding is ' +
        'the full total or nothing, never a remainder. An invoice counts as overdue only ' +
        'once it has been <b>sent</b> and its due date has passed, which is how the server ' +
        'decides it; a draft past its due date is not a claim on anyone. Voided invoices are ' +
        'excluded from every total rather than counted as zero. There is no card brand, ' +
        'recurrence, billing period, purchase order or stored attachment on this document.' +
      '</div>' +
      '</div>';
  }

  /* "invoices" / "invoice" for the sentence above. */
  function ers (n) { return n === 1 ? 'invoice' : n + ' invoices'; }

  /* ── DETAIL ───────────────────────────────────────────────────────────────── */
  function detail (inv, can, now) {
    var id = String(inv.id || '');
    var s = statusOf(inv);
    var c = cur(inv);
    var od = overdueDays(inv, now);
    var dtp = daysToPay(inv);
    var items = Array.isArray(inv.items) ? inv.items : null;

    var row = function (k, v) {
      return '<div class="ivx-row"><span>' + esc(k) + '</span><b>' + v + '</b></div>';
    };
    var said = function (v, absent) { return v ? esc(String(v)) : '<i>' + esc(absent) + '</i>'; };
    var mrow = function (k, v) {
      var n = num(v);
      return row(k, n === null ? '<i>not recorded</i>' : esc(fmt(n, c)));
    };

    /* Actions follow the document's state machine exactly as the handlers enforce it:
       send only from draft; pay and void only while neither paid nor void. A button the
       server would refuse is worse than no button. */
    var acts = '';
    if (can.send && s === 'draft') {
      acts += '<button class="ivx-btn" data-ivx="send" data-id="' + esc(id) + '">Send to client</button>';
    }
    if (can.pay && s !== 'paid' && s !== 'void') {
      acts += '<button class="ivx-btn ok" data-ivx="pay" data-id="' + esc(id) + '">Mark paid…</button>';
    }
    if (can.void && s !== 'paid' && s !== 'void') {
      acts += '<button class="ivx-btn danger" data-ivx="void" data-id="' + esc(id) + '">Void…</button>';
    }

    return '<div class="ivx-detail">' +
      '<div class="ivx-d-head">' +
        '<div><h3>' + esc(inv.invoiceNumber || 'No number') + '</h3>' +
          '<span class="ivx-st ivx-st--' + statusTone(s) + '">' + esc(s) + '</span>' +
          (od ? '<span class="ivx-late">' + od + ' days past due</span>' : '') + '</div>' +
        '<button class="ivx-btn ghost" data-ivx="close">Close</button>' +
      '</div>' +

      '<div class="ivx-d-grid">' +
        '<section><h4>Amounts</h4>' +
          mrow('Subtotal', inv.subtotal) +
          row('Tax' + (num(inv.taxRate) !== null ? ' (' + esc(inv.taxRate) + '%)' : ''),
              num(inv.tax) === null ? '<i>not recorded</i>' : esc(fmt(num(inv.tax), c))) +
          mrow('Total', inv.total) +
          row('Outstanding', isVoid(inv) ? '<i>voided</i>'
              : isPaid(inv) ? '<i>settled in full</i>'
              : num(inv.total) === null ? '<i>not recorded</i>'
              : '<span class="ivx-owed">' + esc(fmt(num(inv.total), c)) + '</span>') +
        '</section>' +

        '<section><h4>Client</h4>' +
          row('Name', said(inv.clientName, 'not recorded')) +
          row('Email', said(inv.clientEmail, 'no email on the invoice')) +
          row('Phone', said(inv.clientPhone, 'no phone on the invoice')) +
        '</section>' +

        '<section><h4>Dates</h4>' +
          row('Raised', said(when(inv.createdAt), 'not recorded')) +
          row('Due', said(when(inv.dueDate), 'no due date')) +
          row('Sent', said(when(inv.sentAt), 'not sent')) +
          row('Paid', said(when(inv.paidAt), 'not paid')) +
          (inv.voidedAt ? row('Voided', esc(when(inv.voidedAt))) : '') +
          (dtp !== null ? row('Days to pay', dtp) : '') +
        '</section>' +

        '<section><h4>Settlement</h4>' +
          row('Method', isPaid(inv) ? said(inv.paymentMethod, 'not recorded')
                                    : '<i>not settled</i>') +
          row('Reference', inv.paymentRef ? '<code>' + esc(inv.paymentRef) + '</code>'
                                          : '<i>none recorded</i>') +
          (inv.voidReason ? row('Void reason', esc(inv.voidReason)) : '') +
          '<div class="ivx-hint">Settlement is recorded in one step with a reference; there ' +
            'is no partial payment and no credit note on this document.</div>' +
        '</section>' +
      '</div>' +

      '<section class="ivx-items"><h4>Line items' + (items ? ' (' + items.length + ')' : '') + '</h4>' +
        (items && items.length
          ? items.map(function (li) {
              var q = num(li.quantity), up = num(li.unitPrice), lt = num(li.total);
              return '<div class="ivx-item">' +
                '<div><b>' + esc(li.description || 'No description') + '</b></div>' +
                '<span class="ivx-dim">' + (q === null ? '<i>qty?</i>' : '× ' + esc(q)) + '</span>' +
                '<span class="ivx-dim">' + (up === null ? '<i>no unit price</i>'
                                                        : esc(fmt(up, c))) + '</span>' +
                '<span>' + (lt === null ? '<i class="ivx-dim">—</i>' : esc(fmt(lt, c))) + '</span>' +
              '</div>';
            }).join('')
          : '<div class="ivx-hint">This invoice records no line items.</div>') +
      '</section>' +

      (inv.notes
        ? '<section class="ivx-notes"><h4>Notes</h4><p>' + esc(inv.notes) + '</p></section>'
        : '') +

      '<div class="ivx-actions">' + acts +
        '<span class="ivx-hint">These are the actions this page already owned, with the same ' +
          'prompts. Each appears only where the server would accept it: send from a draft, ' +
          'mark paid or void while the invoice is neither paid nor voided. Voiding also ' +
          'requires shop-manager authority, which the server checks — not this screen.</span>' +
      '</div>' +
    '</div>';
  }

  function mount (opts) {
    var o = opts || {};
    var host = o.host;
    if (!host || !Array.isArray(o.invoices)) return false;
    injectCss();

    var A = o.actions || {};
    var state = {
      invoices: o.invoices, q: '', qRaw: '', status: 'all', open: null, now: o.now || Date.now(),
      can: { send: !!A.send, pay: !!A.markPaid, void: !!A.voidInvoice },
    };
    var draw = function () { render(host, state); };
    draw();

    if (host.__ivxOff) { try { host.__ivxOff(); } catch (_) {} }
    var bound = [];
    var on = function (type, fn) { host.addEventListener(type, fn); bound.push([type, fn]); };
    host.__ivxOff = function () {
      for (var i = 0; i < bound.length; i++) host.removeEventListener(bound[i][0], bound[i][1]);
      bound = [];
    };

    on('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('[data-ivx]');
      if (!b) return;
      var k = b.getAttribute('data-ivx'), id = b.getAttribute('data-id');
      if (k === 'status') { state.status = b.getAttribute('data-v'); state.open = null; return draw(); }
      if (k === 'open')  { state.open = id; return draw(); }
      if (k === 'close') { state.open = null; return draw(); }
      if (k === 'send' && A.send) return A.send(id);
      if (k === 'pay' && A.markPaid) return A.markPaid(id);
      if (k === 'void' && A.voidInvoice) return A.voidInvoice(id);
    });

    var t = null;
    on('input', function (ev) {
      var el = ev.target;
      if (!el.getAttribute || el.getAttribute('data-ivx') !== 'q') return;
      var v = el.value;
      clearTimeout(t);
      t = setTimeout(function () {
        state.qRaw = v; state.q = String(v || '').trim().toLowerCase();
        draw();
        var again = host.querySelector('[data-ivx="q"]');
        if (again) { again.focus(); try { again.setSelectionRange(v.length, v.length); } catch (_) {} }
      }, 180);
    });
    return true;
  }

  function injectCss () {
    if (document.getElementById(CSS_ID)) return;
    var l = document.createElement('link');
    l.id = CSS_ID; l.rel = 'stylesheet'; l.href = 'sokoni-invoice-desk.css';
    document.head.appendChild(l);
  }

  var api = {
    mount: mount, _render: function (h, s) { return render(h, s); },
    _overdueDays: overdueDays, _daysToPay: daysToPay, _statusTone: statusTone,
    _isOpen: isOpen, _isVoid: isVoid,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniInvoiceDesk = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
