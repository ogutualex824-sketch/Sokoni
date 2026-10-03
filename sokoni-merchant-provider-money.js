/* ═══════════════════════════════════════════════════════════════════════════════════
   sokoni-merchant-provider-money.js — merchant-v2 PROVIDER session: Payments · Receipts · Plan  (sokoni-b2, 2026-10-03)
   The PROVIDER view of the ONE Financial Center business-wallet authority — never a second wallet, never a second receipt
   system, never a client-unlocked plan. Every figure is a server read (sokoni-2f commercial-fn f1ce058):
     payments  providerLedger {}  → availableKES · pending (paid_held bookings) · totals (gross / SOKONI commission / provider
               net / refunds / deductions / released / held, from the caller's PROVIDER receipts) · ledger entries
               (walletTransactions, each with its booking / order ref) · payout history · payoutEligibility.
               An unreadable source is null → "—", never 0. WITHDRAWALS: the canonical withdrawal path (wallet.
               requestSellerPayout) is FROZEN by the owner (open payout-PIN / external-draw issues), so the request control
               ships DISABLED with that reason — no client shortcut, and providerRequestPayout (dead on the wallet path) is
               never wired.
     receipts  myTransactionReceipts {role:'provider', limit, before}  — the canonical receipt records where the caller is
               the counterparty: receipt no, transaction kind / subtype, booking / order / project links, amount, actual
               IntaSend method (null → "—"), SOKONI commission, provider net, status, date.
     plan      subGetPlans {hubType:'marketing'} (catalogue, CENTS) · subGetStatus (current) · createPaymentIntent {planId,
               billingCycle:'monthly', phone} (no purpose → subscription path; the webhook activates). Entitlements are
               enforced ONLY by the server (requireFeature); this page shows plan features and never unlocks anything.
   Routes are provider-only and GATED (sokoni-e3 C2): prov-payments / prov-receipts require 'module:earnings', prov-plan
   requires 'module:subscription' — granted only on VALID_APPROVAL + AVAILABLE from the single businessWorkspace answer.
   P0-F: plan purchase only when the session's editable decision is exactly true. No PIN is ever shown here (owner).
   ═══════════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kesC = (c) => (c == null ? '—' : 'KES ' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-KE'));
  const kesW = (k) => (k == null ? '—' : 'KES ' + (Math.round(Number(k) || 0)).toLocaleString('en-KE'));
  const when = (v) => { const ms = typeof v === 'number' ? v : (v && (v._seconds || v.seconds)) ? (v._seconds || v.seconds) * 1000 : Date.parse(v); return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('en-KE') : '—'; };
  const TONE = { paid_held: 'pending', pending: 'pending', settled: 'paid', released: 'paid', paid: 'paid', completed: 'paid', refunded: 'failed', failed: 'failed', cancelled: 'cancelled', active: 'paid' };
  const badge = (s) => '<span class="badge ' + (TONE[s] || '') + '">' + esc(String(s || '—').replace(/_/g, ' ')) + '</span>';
  const stat = (v, l, neutral) => '<div class="stat' + (neutral ? ' neutral' : '') + '"><b>' + esc(v) + '</b><small>' + esc(l) + '</small></div>';
  const state = (ico, t, sub) => '<div class="state"><span class="ico">' + ico + '</span><b>' + esc(t) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
  const card = (top, sub, extra) => '<div class="ord"><div class="ord-top">' + top + '</div>' + (sub ? '<div class="ord-sub">' + sub + '</div>' : '') + (extra || '') + '</div>';
  const SK = '<div class="sk"><div class="sk-line" style="width:60%"></div><div class="sk-line" style="width:35%"></div></div>';
  const VIEWS = ['payments', 'receipts', 'plan'];

  function mount(host, ctx) {
    if (!host || !ctx) return null;
    const view = VIEWS.indexOf(ctx.view) >= 0 ? ctx.view : 'payments';
    const call = (name, data) => ctx.call(name, data || {});
    const canEdit = () => !!(ctx.editable && ctx.editable() === true);
    let alive = true, cursor = null;
    const paint = (h) => { if (alive) host.innerHTML = h; };
    const fail = (e) => paint('<div class="note err"><b>Could not load.</b> ' + esc((e && e.message) || 'The server did not answer.') + ' This is not an empty account.</div>');

    async function payments() {
      paint('<div class="stats">' + SK + SK + '</div>');
      const L = await call('providerLedger');
      const t = L.totals || null, pe = L.payoutEligibility || null, pend = L.pending || null;
      const trunc = t && t.window && t.window.truncated;
      const reasons = Array.isArray(L.reasons) && L.reasons.length ? '<div class="note">Some figures could not be read (' + esc(L.reasons.join(', ')) + ') and show as —.</div>' : '';
      paint('<div class="greet"><b>Payments</b><small>Your business wallet on SOKONI — not the customer\'s payment, and not SOKONI\'s revenue.' + (trunc ? ' Totals cover your last ' + esc(t.window.scanned) + ' receipts.' : '') + '</small></div>'
        + '<div class="stats">' + stat(kesW(L.availableKES), 'Available', L.availableKES == null || !L.availableKES)
        + stat(pend ? kesC(pend.amountCents) : '—', 'Pending (held until PIN)', !pend || !pend.amountCents)
        + stat(t ? kesC(t.grossCents) : '—', 'Gross', !t || !t.grossCents) + stat(t ? kesC(t.platformFeeCents) : '—', 'SOKONI commission', !t || !t.platformFeeCents)
        + stat(t ? kesC(t.providerNetCents) : '—', 'Your net', !t || !t.providerNetCents) + stat(t ? kesC(t.refundedCents) : '—', 'Refunds', !t || !t.refundedCents)
        + stat(t ? kesC(t.deductionsCents) : '—', 'Adjustments', !t || !t.deductionsCents) + stat(t ? kesC(t.releasedCents) : '—', 'Settled to wallet', !t || !t.releasedCents) + '</div>'
        + reasons
        + '<div class="sec-t">Withdraw</div><div class="note" style="margin-top:0">'
          + (pe ? 'Minimum ' + esc(kesW(pe.minimumKES)) + ' · available ' + esc(kesW(pe.availableKES)) + ' · ' + (pe.eligible ? 'eligible' : 'not yet eligible') : 'Eligibility could not be read — shown as —.')
          + '<div class="actions" style="margin-top:10px"><button type="button" class="act ghost" disabled aria-disabled="true">Withdraw — coming soon</button></div>'
          + '<small>Withdrawals are paused while SOKONI completes payout security. Your balance is safe in your business wallet.</small></div>'
        + '<div class="sec-t">Pending — paid and held</div>' + ((pend && (pend.bookings || []).length) ? '<div class="ord-list">' + pend.bookings.map((b) => card('<span class="ord-id">' + esc(b.service || b.kind || 'Booking') + '</span><span class="ord-amt">' + esc(kesC(b.amountCents)) + '</span>', badge(b.status || 'paid_held') + (b.workProjectId ? '<span>milestone</span>' : '') + '<span class="mono">' + esc(b.bookingId) + '</span>')).join('') + '</div>' : state('⏳', pend ? 'Nothing held right now' : 'Could not read held payments'))
        + '<div class="sec-t">Ledger</div>' + ((L.entries || []).length ? '<div class="ord-list">' + L.entries.map((e) => card('<span class="ord-id">' + esc(e.description || e.type) + '</span><span class="ord-amt">' + esc(kesW(e.amountKES)) + '</span>', badge(e.status) + '<span>' + esc(e.type || '') + '</span><span class="when">' + esc(when(e.createdAt)) + '</span>', (e.bookingId || e.orderId) ? '<div class="mono">' + esc(e.bookingId || e.orderId) + '</div>' : '')).join('') + '</div>' : state('📒', L.entries ? 'No wallet entries yet' : 'Could not read the ledger'))
        + '<div class="sec-t">Payout history</div>' + ((L.payouts || []).length ? '<div class="ord-list">' + L.payouts.map((p) => card('<span class="ord-id">' + esc(p.method || 'Payout') + '</span><span class="ord-amt">' + esc(kesW(p.amountKES)) + '</span>', badge(p.status) + '<span class="when">' + esc(when(p.paidAt || p.createdAt)) + '</span>', p.reference ? '<div class="mono">' + esc(p.reference) + '</div>' : '')).join('') + '</div>' : state('🏦', L.payouts ? 'No payouts yet' : 'Could not read payouts')));
    }

    async function receipts(more) {
      if (!more) paint('<div class="ord-list">' + SK + SK + '</div>');
      const r = await call('myTransactionReceipts', Object.assign({ role: 'provider', limit: 25 }, cursor ? { before: cursor } : {}));
      const rows = (r && (r.receipts || r.items)) || [];
      const html = rows.map((x) => card('<span class="ord-id">' + esc(x.receiptNo || '—') + '</span><span class="ord-amt">' + esc(kesC(x.paidCents)) + '</span>',
        badge(x.status) + '<span>' + esc((x.kind || '') + (x.subtype ? ' · ' + x.subtype : '')) + '</span><span>' + esc(x.method || '—') + '</span><span class="when">' + esc(when(x.issuedAt)) + '</span>',
        '<div class="ord-sub"><span>SOKONI commission ' + esc(kesC(x.platformFeeCents)) + '</span><span>Your net ' + esc(kesC(x.providerNetCents)) + '</span>' + (x.refundedCents ? '<span>Refunded ' + esc(kesC(x.refundedCents)) + '</span>' : '') + '</div>'
          + '<div class="mono">' + esc([x.links && (x.links.bookingId || x.links.orderId), x.links && x.links.workProjectId ? 'project ' + x.links.workProjectId : ''].filter(Boolean).join(' · ')) + '</div>')).join('');
      cursor = rows.length ? (rows[rows.length - 1].issuedAt || null) : cursor;
      const head = '<div class="greet"><b>Receipts</b><small>SOKONI\'s official receipts for payments you received. One receipt per payment; the method is what IntaSend reported.</small></div>';
      if (!more) paint(head + (rows.length ? '<div class="ord-list" data-rlist>' + html + '</div>' + (rows.length >= 25 ? '<div class="actions" style="margin-top:12px"><button type="button" class="act ghost" data-more>Load older</button></div>' : '') : state('🧾', 'No receipts yet', 'A receipt appears when a customer\'s payment is confirmed by SOKONI.')));
      else { const l = host.querySelector('[data-rlist]'); if (l) l.insertAdjacentHTML('beforeend', html); if (rows.length < 25) { const b = host.querySelector('[data-more]'); if (b) b.remove(); } }
    }

    async function plan() {
      paint('<div class="ord-list">' + SK + SK + '</div>');
      const [cat, st] = await Promise.all([call('subGetPlans', { hubType: 'marketing' }), call('subGetStatus').catch(() => null)]);
      const plans = ((cat && cat.plans) || []).filter((p) => p.hubType === 'marketing');
      const cur = st && st.subscriptions && st.subscriptions.marketing;
      const curId = cur && cur.status === 'active' ? cur.planId : (st ? 'marketing_free' : null);
      const FEAT = { services_limit: 'Services', portfolio_limit: 'Portfolio items', team_seats: 'Team seats', campaigns_limit: 'Campaigns', advanced_leads: 'Advanced leads', quotations: 'Quotations', invoicing: 'Invoicing', campaign_tools: 'Campaign tools', client_management: 'Client management', reporting: 'Reporting' };
      const feats = (f) => Object.keys(FEAT).filter((k) => f && f[k] !== undefined && f[k] !== false && f[k] !== 0).map((k) => '<span class="tag">' + esc(FEAT[k]) + (typeof f[k] === 'number' ? ' · ' + (f[k] < 0 ? 'unlimited' : f[k]) : '') + '</span>').join('');
      paint('<div class="greet"><b>Plan</b><small>' + (curId ? 'Current plan: <b>' + esc((plans.find((p) => p.id === curId) || {}).name || curId) + '</b>' : 'Your current plan could not be read.') + ' Limits are SOKONI\'s; paid plans activate only after the payment is confirmed.</small></div>'
        + (plans.length ? '<div class="ord-list">' + plans.map((p) => {
          const price = p.price && p.price.monthly;
          const isCur = p.id === curId, paid = Number(price) > 0;
          return card('<span class="ord-id">' + esc(p.name || p.id) + '</span><span class="ord-amt">' + esc(paid ? kesC(price) + ' / month' : 'Free') + '</span>',
            (isCur ? '<span class="badge paid">current</span>' : '') + '<span>' + esc(p.tier || '') + '</span>', '<div class="badges">' + feats(p.features) + '</div>'
              + (paid && !isCur ? (canEdit() ? '<div class="actions" style="margin-top:6px"><button type="button" class="act" data-buy="' + esc(p.id) + '">Upgrade — pay with M-Pesa</button></div>' : '<div class="note">Read-only: plan changes are not available for this account right now.</div>') : ''));
        }).join('') + '</div>' : state('📦', 'Plans could not be loaded'))
        + '<div data-buy-slot></div>');
    }
    async function buy(planId, phone, btn) {
      const m = host.querySelector('[data-buy-msg]');
      try {
        const r = await call('createPaymentIntent', { planId, billingCycle: 'monthly', phone });
        if (m) { m.textContent = 'Check your phone to approve the M-Pesa payment. Your plan activates once SOKONI confirms it.' + (r && r.ref ? ' Ref ' + r.ref : ''); m.className = 'msg ok'; }
      } catch (e) { if (btn) btn.disabled = false; if (m) { m.textContent = (e && e.message) || 'The payment could not start.'; m.className = 'msg bad'; } }
    }

    async function onClick(e) {
      const b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      if ('more' in b.dataset) { b.disabled = true; try { await receipts(true); } catch (er) { b.disabled = false; } return; }
      if (b.dataset.buy) {
        if (!canEdit()) return;
        const slot = host.querySelector('[data-buy-slot]');
        if (slot) slot.innerHTML = '<form class="note" data-buy-form data-plan="' + esc(b.dataset.buy) + '"><label class="fld">M-Pesa number<input name="phone" inputmode="tel" maxlength="16" required placeholder="07XX XXX XXX"></label><div class="msg" data-buy-msg role="status"></div><div class="actions"><button type="submit" class="act">Send payment request</button></div></form>';
      }
    }
    async function onSubmit(e) {
      const f = e.target; if (!(f.matches && f.matches('[data-buy-form]'))) return;
      e.preventDefault();
      if (!canEdit()) return;
      const phone = String(f.elements.phone.value || '').replace(/\s/g, '');
      const m = f.querySelector('[data-buy-msg]');
      if (!/^(?:\+?254|0)[17]\d{8}$/.test(phone)) { if (m) { m.textContent = 'Enter a valid Kenyan mobile number.'; m.className = 'msg bad'; } return; }
      const btn = f.querySelector('button[type="submit"]'); if (btn) btn.disabled = true;
      await buy(f.dataset.plan, phone, btn);
    }
    host.addEventListener('click', onClick);
    host.addEventListener('submit', onSubmit);
    (async () => { try { if (view === 'payments') await payments(); else if (view === 'receipts') await receipts(false); else await plan(); } catch (e) { fail(e); } })();
    return { destroy() { alive = false; host.removeEventListener('click', onClick); host.removeEventListener('submit', onSubmit); } };
  }
  root.SokoniMerchantProviderMoney = { mount, VIEWS };
})(typeof window !== 'undefined' ? window : this);
