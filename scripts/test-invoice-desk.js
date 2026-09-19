/* ══════════════════════════════════════════════════════════════════════════════
   INVOICE DESK — certification
   scripts/test-invoice-desk.js            node scripts/test-invoice-desk.js

   `invoiceList` is SHOP-SCOPED: it takes a shopId, runs _assertShop, and returns a capped,
   UNORDERED page which the handler sorts afterwards. There is no admin-scoped invoice read
   anywhere in functions/, no cross-shop query, no total and no prior period.

   Settlement is binary — invoiceMarkPaid flips status in one transaction and there is no
   payment ledger — so an invoice is owed in full or not at all.

   Most of this suite is the desk refusing what the mockup wanted and this platform cannot
   source, each paired with an inverting control.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

global.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute () {}, appendChild () {}, style: {} }),
  head: { appendChild () {} },
};
global.window = globalThis;
const D = require(path.join(ROOT, 'sokoni-invoice-desk.js'));

const host = () => ({ innerHTML: '', addEventListener () {}, querySelector: () => null,
                      querySelectorAll: () => [] });

const NOW = Date.parse('2026-09-19T00:00:00Z');
/* Exactly what invoiceCreate writes. */
const inv = (o) => Object.assign({
  id: 'i1', shopId: 's1', invoiceNumber: 'INV-0001',
  clientName: 'TechCorp Ltd', clientEmail: 'ap@techcorp.co.ke', clientPhone: '+254700000111',
  items: [{ description: 'Brand identity', quantity: 1, unitPrice: 120000, total: 120000 }],
  subtotal: 120000, taxRate: 16, tax: 19200, total: 139200, currency: 'KES',
  notes: null, dueDate: '2026-08-15T00:00:00Z', status: 'sent',
  sentAt: '2026-08-01T00:00:00Z', paidAt: null, voidedAt: null,
  paymentRef: null, paymentMethod: null,
  createdBy: 'u1', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
}, o);

/* The notes NAME what the desk refuses to draw, so absence checks run with them removed. */
const shownOnly = h => h.replace(/<div class="ivx-note">[\s\S]*?<\/div>/g, '');

function draw (invoices, over) {
  const h = host();
  D._render(h, Object.assign(
    { invoices, q: '', qRaw: '', status: 'all', open: null, now: NOW,
      can: { send: true, pay: true, void: true } }, over));
  return h.innerHTML;
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  INVOICE DESK');
console.log('══════════════════════════════════════════════════════════════════');

/* ── 1. WHAT THIS PLATFORM CANNOT SOURCE ────────────────────────────────────── */
head('1 - the mockup figures with no source are not drawn');
{
  const html = draw([inv(), inv({ id: 'i2', status: 'paid', paidAt: '2026-08-20T00:00:00Z' })]);
  const shown = shownOnly(html);

  ok('no month-on-month change', !/vs last \d+ days|vs last month|[↑↓]\s*\d/i.test(shown));
  ok('no percentage figure', !/\d+(\.\d+)?%/.test(shown.replace(/style="width:[^"]*"/g, '')));
  ok('no card brand', !/\b(visa|mastercard|amex|american express|ach)\b/i.test(shown));
  ok('no masked card number', !/••••|\*{4}\s*\d{4}/.test(shown));
  ok('no recurrence claim', !/\b(monthly|one-time|recurring)\b/i.test(shown));
  ok('no billing period', !/billing period/i.test(shown));
  ok('no purchase order', !/purchase order|\bPO-\d/i.test(shown));
  ok('no attachment is claimed', !/attachment|\.pdf/i.test(shown));
  /* KES is what the document carries; USD appeared only in the mockup. */
  ok('no US dollar figure', !/\bUSD\b|\$\d/.test(shown));
  ok('control — the document currency IS rendered', /KES/.test(shown));

  /* NO SHOP-WIDE TOTAL — asserted on the label element, not page vocabulary. */
  const labels = [...html.matchAll(/class="ivx-stat-l">([^<]+)</g)].map(m => m[1]);
  ok('control — stat labels found', labels.length >= 6, labels.join(' · '));
  ok('the first stat is "Loaded"', labels[0] === 'Loaded', labels[0]);
  ok('no label claims a total', !labels.some(l => /^total\b/i.test(l)));
  ok('every stat states its scope', (html.match(/ivx-stat-s/g) || []).length === labels.length);

  ok('it explains the page is capped and unordered', /capped and unordered/.test(html));
  ok('it explains the status filter is page-local', /never the shop's full set/.test(html));
  ok('it explains there is no prior period', /no prior-period figure exists/.test(html));
}

/* ── 2. SETTLEMENT IS BINARY ────────────────────────────────────────────────── */
head('2 - there is no partial payment, so no remainder is invented');
{
  const fn = read('functions/finance-os-sprint43.js');
  const mp = fn.slice(fn.indexOf('exports.invoiceMarkPaid'), fn.indexOf('exports.invoiceVoid'));
  ok('control — markPaid was found', mp.length > 100);
  ok('markPaid sets a status, not an amount', /status: 'paid'/.test(mp) && !/amountPaid|partial/.test(mp));

  const unpaid = draw([inv()]);
  const paid = draw([inv({ status: 'paid', paidAt: '2026-08-20T00:00:00Z' })]);
  ok('an unsettled invoice is owed in full', /KES\s*139,200/.test(unpaid));
  ok('a settled invoice shows "settled", not a remainder', />settled</.test(paid));
  ok('no balance-due remainder is computed', !/balance due/i.test(shownOnly(unpaid)));
  ok('the column is named Outstanding', /<th class="ivx-r">Outstanding<\/th>/.test(unpaid));
  ok('and the page says why it has only two values', /the full total or nothing/.test(unpaid));

  /* A VOID invoice is neither owed nor collected — excluded, not counted as zero. */
  const withVoid = draw([inv(), inv({ id: 'i2', status: 'void', voidedAt: '2026-08-10T00:00:00Z' })]);
  ok('a voided invoice shows "voided"', />voided</.test(withVoid));
  ok('and is excluded from the invoiced figure', /KES\s*139,200/.test(withVoid) &&
     !/KES\s*278,400/.test(withVoid), 'not doubled by the void');
  ok('the page says voided are excluded', /excluded from every total/.test(withVoid));
}

/* ── 3. OVERDUE IS THE SERVER'S DEFINITION ──────────────────────────────────── */
head('3 - a draft past its due date is not a claim on anyone');
{
  const fn = read('functions/finance-os-sprint43.js');
  ok('control — the server flags only SENT invoices',
     /status === 'sent' && inv\.dueDate && new Date\(inv\.dueDate\) < now/.test(fn));

  const sentLate = inv();                                   /* due 15 Aug, now 19 Sep */
  const draftLate = inv({ id: 'i2', status: 'draft', sentAt: null });
  ok('a sent invoice past due is overdue', D._overdueDays(sentLate, NOW) === 35,
     String(D._overdueDays(sentLate, NOW)));
  ok('a DRAFT past due is NOT overdue', D._overdueDays(draftLate, NOW) === null);
  ok('control — a sent invoice not yet due is not overdue',
     D._overdueDays(inv({ dueDate: '2026-10-01T00:00:00Z' }), NOW) === null);
  ok('a paid invoice is never overdue',
     D._overdueDays(inv({ status: 'paid' }), NOW) === null);

  const html = draw([sentLate, draftLate]);
  ok('the late row is marked', /35d late/.test(html));
  ok('only one row is late', (html.match(/d late/g) || []).length === 1);
  ok('an overdue tab exists when something is late', /data-v="overdue"/.test(html));
  ok('control — no overdue tab when nothing is late',
     !/data-v="overdue"/.test(draw([inv({ dueDate: '2026-10-01T00:00:00Z' })])));
  ok('the overdue tab filters on the predicate, not a status',
     draw([sentLate, draftLate], { status: 'overdue' }).indexOf('INV-0001') > -1);
  ok('and the page explains the sent-only rule', /once it has been <b>sent<\/b>/.test(html));
}

/* ── 4. AGING IS REAL, AND SAYS WHAT IT COVERS ──────────────────────────────── */
head('4 - aging is derived from fields that exist');
{
  const rows = [
    inv({ id: 'a', dueDate: '2026-10-10T00:00:00Z' }),          /* not yet due  */
    inv({ id: 'b', dueDate: '2026-09-01T00:00:00Z' }),          /* 18 days      */
    inv({ id: 'c', dueDate: '2026-08-01T00:00:00Z' }),          /* 49 days      */
    inv({ id: 'd', dueDate: '2026-06-20T00:00:00Z' }),          /* 91 days      */
    inv({ id: 'e', dueDate: null }),                            /* unbucketable */
  ];
  const html = draw(rows);
  ok('an aging block is rendered', /ivx-aging/.test(html));
  ['Current', '1–30 days', '31–60 days', '61–90 days', '91+ days'].forEach(b =>
    ok('bucket "' + b + '" is present', html.indexOf(b) > -1));
  ok('an invoice with no due date is disclosed, not silently dropped',
     /1 with no due date not bucketed/.test(html));
  ok('aging names the population it covers', /sent, unsettled invoices on this page/.test(html));
  /* A PAID invoice is not outstanding, so it must not age. */
  ok('a paid invoice does not appear in aging',
     draw([inv({ status: 'paid', dueDate: '2026-06-20T00:00:00Z' })])
       .indexOf('1 invoice · past due') === -1);

  /* AGING AND THE OVERDUE FIGURE MUST USE ONE RULE. A draft past its due date would
     otherwise age while not counting as overdue, and the two blocks would disagree by
     exactly that invoice with nothing on screen to explain the gap. */
  const withDraft = draw([
    inv({ id: 'sent', dueDate: '2026-08-01T00:00:00Z' }),                       /* 49d, sent  */
    inv({ id: 'drft', status: 'draft', sentAt: null, dueDate: '2026-09-01T00:00:00Z' }),
  ]);
  const buckets = [...withDraft.matchAll(/ivx-age-n">([^<]+)</g)].map(m => m[1]);
  const pastDue = buckets.slice(1).filter(v => /KES/.test(v));
  ok('control — exactly one past-due bucket is filled', pastDue.length === 1, pastDue.join(' · '));
  ok('the unsent draft is NOT aged into a past-due bucket',
     pastDue[0] === 'KES 139,200', pastDue[0]);
  ok('and its exclusion is stated, not silent',
     /1 unsent draft excluded, nothing has been claimed yet/.test(withDraft));
  ok('aging names the population it covers', /sent, unsettled invoices on this page/.test(withDraft));
}

/* ── 5. DAYS TO PAY ─────────────────────────────────────────────────────────── */
head('5 - the average is computed; its trend is not');
{
  ok('days to pay is measured from creation to payment',
     D._daysToPay(inv({ status: 'paid', createdAt: '2026-08-01T00:00:00Z',
                        paidAt: '2026-08-20T00:00:00Z' })) === 19);
  ok('an unpaid invoice has none', D._daysToPay(inv()) === null);
  ok('a paid invoice with no paidAt has none', D._daysToPay(inv({ status: 'paid' })) === null);
  const html = draw([inv({ status: 'paid', paidAt: '2026-08-20T00:00:00Z' })]);
  ok('the average is rendered', /Avg days to pay/.test(html));
  ok('with no trend beside it', !/vs last/i.test(shownOnly(html)));
  ok('a page with nothing settled says so',
     /no settled invoice on this page/.test(draw([inv()])));
}

/* ── 6. ACTIONS MATCH THE SERVER'S STATE MACHINE ────────────────────────────── */
head('6 - no button the server would refuse');
{
  const openD = (o, over) => draw([o], Object.assign({ open: o.id }, over));

  const draft = inv({ id: 'd1', status: 'draft' });
  ok('a draft offers Send', /data-ivx="send"/.test(openD(draft)));
  ok('a SENT invoice does not offer Send again', !/data-ivx="send"/.test(openD(inv({ id: 'i1' }))));
  ok('an unpaid invoice offers Mark paid', /data-ivx="pay"/.test(openD(inv({ id: 'i1' }))));
  ok('a PAID invoice offers neither pay nor void',
     !/data-ivx="pay"|data-ivx="void"/.test(openD(inv({ id: 'p1', status: 'paid' }))));
  ok('a VOID invoice offers neither',
     !/data-ivx="void"|data-ivx="pay"/.test(openD(inv({ id: 'v1', status: 'void' }))));

  /* Which mirrors the handlers. */
  const fn = read('functions/finance-os-sprint43.js');
  ok('control — the server refuses a paid void', /cannot void a paid invoice/.test(fn));
  ok('control — the server refuses a double pay', /already paid/.test(fn));
  ok('control — the server refuses sending a void', /cannot send voided invoice/.test(fn));

  /* Capability follows the actions supplied. */
  const mod = strip(read('sokoni-invoice-desk.js'));
  ok('capability is derived from the actions passed',
     /can: \{ send: !!A\.send, pay: !!A\.markPaid, void: !!A\.voidInvoice \}/.test(mod));
  ok('no buttons at all when no action is owned',
     !/data-ivx="send"|data-ivx="pay"|data-ivx="void"/
       .test(openD(draft, { can: {} })));

  ok('the module performs no call of its own', !/httpsCallable|_cf\(|collection\(/.test(mod));
  ok('and no write', !/\.set\(|\.update\(|runTransaction/.test(mod));
}

/* ── 7. SAFETY ──────────────────────────────────────────────────────────────── */
head('7 - hostile invoice content cannot reach the DOM');
{
  const x = '<img src=x onerror=alert(1)>';
  const html = draw([inv({ id: x, invoiceNumber: x, clientName: x, notes: x,
                           paymentRef: x, status: x,
                           items: [{ description: x, quantity: 1, unitPrice: 1, total: 1 }] })],
                    { open: x });
  ok('every field is escaped', html.indexOf('<img') === -1);
  ok('the payload is present but inert', html.indexOf('&lt;img') > -1);
  ok('the id is escaped in every action attribute', !/data-id="[^"]*</.test(html));
}

/* ── 8. THE HOSTS ───────────────────────────────────────────────────────────── */
head('8 - one desk, reached from both consoles');
{
  const aos = read('sokoni-aos.js');
  const html = read('admin-os.html');
  const sa = read('super-admin.html');

  /* ADMINOS owns the panel. */
  ok('AdminOS registers an invoices section', /invoices:\s+\(\) => _loadInvoices\(\)/.test(aos));
  ok('AdminOS has one nav entry', (html.match(/data-section="invoices"/g) || []).length === 1);
  ok('AdminOS has the panel and host', /id="panel-invoices"/.test(html) && /id="invoicesBody"/.test(html));
  ok('admin-os.html loads the module before the shell',
     html.indexOf('sokoni-invoice-desk.js') > -1 &&
     html.indexOf('sokoni-invoice-desk.js') < html.indexOf('<script src="sokoni-aos.js">'));

  /* THE ROUTE THAT EXISTS. The finance callables were consolidated into ONE service;
     index.js exports no `invoiceList`, so calling it by name targets nothing. */
  ok('control — index.js does NOT export invoiceList',
     !/exports\.invoiceList/.test(read('functions/index.js')));
  ok('control — the dispatcher IS exported',
     /exports\.financeSprintDispatch/.test(read('functions/index.js')));
  ok('AdminOS routes invoices through the dispatcher',
     /httpsCallable\("financeSprintDispatch"\)\(\{ op, /.test(aos));
  ok('and never calls an invoice op by name',
     !/httpsCallable\("invoice/.test(aos));

  /* SHOP SCOPE — the panel must ask, not imply a platform ledger. */
  ok('the loader requires a shopId', /if \(!shopId\)/.test(aos));
  ok('and says why rather than showing an empty table',
     /no platform-wide invoice ledger/.test(aos));
  ok('control — the contract really is shop-scoped',
     /await _assertShop\(uid, shopId\)/.test(read('functions/finance-os-sprint43.js')));
  ok('control — and admits a platform admin',
     /role === 'admin'\) return 'admin'/.test(read('functions/finance-os-sprint43.js')));

  /* SUPER ADMIN — a link, exactly as Security is. */
  ok('Super Admin links to the canonical page', /admin-os\.html#invoices/.test(sa));
  ok('it is a LINK, not a second implementation', !/id="panel-invoices"/.test(sa));
  ok('and no desk markup was copied into it', !/class="ivx-/.test(sa));
  ok('control — the same precedent as Security', /admin-os\.html#security/.test(sa));

  /* ADDITIVE / REMOUNT SAFETY. */
  const mod = strip(read('sokoni-invoice-desk.js'));
  ok('it declines rather than throwing',
     /if \(!host \|\| !Array\.isArray\(o\.invoices\)\) return false;/.test(mod));
  ok('listeners are unbound before a remount rebinds them', /host\.__ivxOff/.test(mod));
  ok('every listener goes through the tracked binder', !/host\.addEventListener\('/.test(mod));
}

console.log('\n  what this suite does NOT prove');
console.log('  UNPROVEN  live dispatcher responses        [needs an authenticated admin]');
console.log('  KNOWN     finance-invoices.html calls invoiceList/Create/Send/MarkPaid/Void');
console.log('            by name. index.js exports none of them — that page targets five');
console.log('            functions that do not exist. Its siblings (budget, expenses,');
console.log('            reconcile) were migrated to financeSprintDispatch; it was not.');
console.log('            NOT repaired here: separate surface, separate change.');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
