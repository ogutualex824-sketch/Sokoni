/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-ent-workspace.js — the provider's Entertainment business workspace.

   Sections (one module for provider-dashboard.html and venue-manager.html):
     calendar · availability · stats · ratecards · enquiries · calls · messaging · discounts

   Every action is a bookingDispatch callable; the server validates, audits and enforces
   the plan (Premium / Equipped settings come back as PLAN_REQUIRED). Unknown figures
   render "—", never 0 (CLAUDE.md UI Data Integrity). Nothing is stored in localStorage.

   Usage: SokoniEntWorkspace.mount(host, { section, venueId? })
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kes = (c) => (c == null || !Number.isFinite(Number(c)) ? '—' : 'KES ' + (Number(c) / 100).toLocaleString('en-KE'));
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-KE'));
  const when = (ms) => (ms ? new Date(Number(ms)).toLocaleString('en-KE') : '—');
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WHO = { ANYONE: 'Anyone on SOKONI', VERIFIED: 'Verified SOKONI users', PURCHASED: 'Customers who have purchased', ACTIVE_BOOKING: 'Customers with an active booking', ENQUIRY: 'Customers who have enquired before', NOBODY: 'Nobody (no public enquiries)' };
  const RESP = { '': 'Not shown', WITHIN_15_MIN: 'Within 15 minutes', WITHIN_1_HOUR: 'Within 1 hour', SAME_DAY: 'Same day', WITHIN_24_HOURS: 'Within 24 hours', CUSTOM: 'Custom' };
  const CATS = ['AVAILABILITY', 'PRICING', 'SERVICE_DETAILS', 'LOCATION', 'CUSTOM_REQUEST', 'EVENT_QUESTION', 'COLLABORATION', 'OTHER'];
  const TPL = ['WELCOME', 'AWAY', 'BOOKING_CONFIRMATION', 'PAYMENT_INSTRUCTION', 'LOCATION', 'FAQ', 'REFUND_POLICY'];
  const BOOKABLE_WHY = { NOT_VERIFIED: 'Your application must be approved before public bookings open.', NOT_APPROVED: 'Your listing is waiting for SOKONI approval.', SUSPENDED: 'Your account is suspended — public bookings are off.', NOT_ACCEPTING: 'You have turned bookings off.' };
  function call(op, data) {
    const fn = root.firebase && root.firebase.functions && root.firebase.functions().httpsCallable('bookingDispatch');
    if (!fn) return Promise.reject(new Error('Unavailable right now.'));
    return fn(Object.assign({ op }, data || {})).then((r) => r.data);
  }
  const CSS = `
  .skws{color:#eee;font-size:14px;max-width:100%}
  .skws *{box-sizing:border-box}
  .skws-tabs{display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:10px;scrollbar-width:none}
  .skws-tab{min-height:44px;white-space:nowrap;padding:8px 14px;border-radius:22px;border:1px solid #262626;background:#141414;color:#bbb;cursor:pointer}
  .skws-tab.on{border-color:#71ff00;color:#71ff00}
  .skws-card{background:#0f0f0f;border:1px solid #1d1d1d;border-radius:14px;padding:14px;margin-bottom:12px;overflow-x:auto}
  .skws-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
  .skws-kpi{background:#121212;border:1px solid #1f1f1f;border-radius:12px;padding:10px}
  .skws-kpi b{display:block;font-size:1.2rem;color:#71ff00}
  .skws label{display:block;font-size:12px;color:#9a9a9a;margin-top:8px}
  .skws input,.skws select,.skws textarea{width:100%;min-height:44px;background:#141414;border:1px solid #262626;color:#eee;border-radius:10px;padding:8px 10px;font-size:16px;margin-top:4px}
  .skws .row{display:flex;gap:8px;flex-wrap:wrap}.skws .row>*{flex:1;min-width:120px}
  .skws-btn{min-height:44px;padding:8px 14px;border-radius:10px;border:1px solid #262626;background:#141414;color:#eee;font-weight:700;cursor:pointer;margin:4px 4px 0 0}
  .skws-btn.pri{background:#71ff00;color:#04120a;border-color:#71ff00}
  .skws-table{width:100%;border-collapse:collapse;font-size:13px}
  .skws-table td,.skws-table th{padding:8px 6px;border-bottom:1px solid #1c1c1c;text-align:left;vertical-align:top}
  .skws-chip{display:inline-block;padding:2px 8px;border-radius:10px;background:#1c1c1c;font-size:11px}
  .skws-msg{font-size:13px;margin:6px 0}
  .skws-err{color:#ff6b6b}.skws-ok{color:#71ff00}
  .skws-plan{font-size:11px;color:#f5c542}
  `;
  function css() { if (!document.getElementById('skws-css')) { const s = document.createElement('style'); s.id = 'skws-css'; s.textContent = CSS; document.head.appendChild(s); } }
  const TABS = [['calendar', 'Calendar'], ['availability', 'Availability'], ['stats', 'Bookings & hours'], ['ratecards', 'Rate cards'], ['enquiries', 'Enquiries'], ['calls', 'Calls'], ['messaging', 'Message settings'], ['discounts', 'Discounts']];

  function mount(host, opts) {
    if (!host) return null;
    css();
    const o = Object.assign({ section: 'calendar' }, opts || {});
    const ident = o.venueId ? { venueId: o.venueId } : {};
    let section = o.section; let cal = null;
    host.innerHTML = `<div class="skws"><div class="skws-tabs" role="tablist">${TABS.map(([k, l]) => `<button type="button" role="tab" class="skws-tab" data-tab="${k}">${esc(l)}</button>`).join('')}</div>
      <div class="skws-msg" data-msg role="status" aria-live="polite"></div><div data-body></div></div>`;
    const body = host.querySelector('[data-body]');
    const msg = (t, bad) => { const m = host.querySelector('[data-msg]'); m.textContent = t || ''; m.className = 'skws-msg ' + (bad ? 'skws-err' : 'skws-ok'); };
    async function act(op, data, ok) {
      msg('Working…');
      try { const r = await call(op, data); msg(ok || 'Saved.'); await render(); return r; }
      catch (e) { const d = e && e.details; msg(d && d.code === 'PLAN_REQUIRED' ? (e.message + ' Upgrade to Premium to use them.') : ((e && e.message) || 'Failed.'), true); return null; }
    }

    const R = {
      async calendar() {
        body.innerHTML = '<div class="skws-card"><div data-cal></div></div>';
        cal = root.SokoniEntCalendar.mount(body.querySelector('[data-cal]'), Object.assign({ mode: 'provider' }, ident));
      },
      async availability() {
        const r = await call('entAvailGetConfig', ident);
        const c = r.config || {};
        const why = r.bookable && !r.bookable.ok ? `<div class="skws-msg skws-err">${esc(BOOKABLE_WHY[r.bookable.code] || 'Public bookings are not open.')}</div>` : '<div class="skws-msg skws-ok">Public bookings are open.</div>';
        const dayRows = DAYS.map((d, i) => { const p = (c.weekly && c.weekly[i] && c.weekly[i][0]) || null; const hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
          return `<div class="row"><label style="flex:0 0 110px">${d}<select name="open_${i}"><option value="1" ${p ? 'selected' : ''}>Open</option><option value="0" ${p ? '' : 'selected'}>Closed</option></select></label>
            <label>From<input type="time" name="from_${i}" value="${p ? hm(p[0]) : '09:00'}"></label><label>To<input type="time" name="to_${i}" value="${p ? hm(p[1]) : '17:00'}"></label></div>`; }).join('');
        body.innerHTML = `<form class="skws-card" data-avform>${why}
          <h4 style="margin:6px 0">Working days &amp; hours</h4>${dayRows}
          <h4 style="margin:14px 0 6px">Slots</h4>
          <div class="row"><label>Slot duration (min)<input type="number" name="durationMins" min="15" max="1440" value="${esc(c.durationMins)}"></label>
            <label>Start a slot every (min)<input type="number" name="stepMins" min="15" max="1440" value="${esc(c.stepMins || '')}" placeholder="same as duration"></label>
            <label>Minimum notice (hours)<input type="number" name="minNoticeHours" min="0" max="72" value="${esc(Math.round((c.minNoticeMins || 0) / 60))}"></label></div>
          <div class="row"><label>Booking horizon (days ahead) <span class="skws-plan">max ${esc(r.limits.maxHorizonDays)}${r.advanced ? '' : ' on your plan'}</span><input type="number" name="horizonDays" min="1" max="730" value="${esc(c.horizonDays)}"></label>
            <label>Buffer before (min)<input type="number" name="bufferBeforeMins" min="0" max="720" value="${esc(c.bufferBeforeMins)}"></label>
            <label>Buffer after (min) ${r.advanced ? '' : '<span class="skws-plan">different before/after: Premium</span>'}<input type="number" name="bufferAfterMins" min="0" max="720" value="${esc(c.bufferAfterMins)}"></label></div>
          <div class="row"><label>Bookings at the same time ${r.advanced ? '' : '<span class="skws-plan">more than 1: Premium</span>'}<input type="number" name="capacity" min="1" max="100" value="${esc(c.capacity)}"></label>
            <label>Max bookings per day (0 = no limit)<input type="number" name="maxPerDay" min="0" max="9999" value="${esc(c.maxPerDay || 0)}"></label>
            <label>Same-day bookings<select name="allowSameDay"><option value="1" ${c.allowSameDay ? 'selected' : ''}>Allowed</option><option value="0" ${c.allowSameDay ? '' : 'selected'}>Not allowed</option></select></label></div>
          <div class="row"><label>After a cancellation<select name="reopenAfterCancel"><option value="1" ${c.reopenAfterCancel !== false ? 'selected' : ''}>Reopen the time</option><option value="0" ${c.reopenAfterCancel === false ? 'selected' : ''}>Keep it unavailable</option></select></label>
            <label>Cool-down after a cancellation (min, 0 = the whole slot)<input type="number" name="cooldownMins" min="0" value="${esc(c.cooldownMins || 0)}"></label></div>
          <h4 style="margin:14px 0 6px">Blackout dates &amp; holidays</h4>
          <label>One date per line (YYYY-MM-DD)<textarea name="closedDates" rows="3">${esc((c.closedDates || []).join('\n'))}</textarea></label>
          <button class="skws-btn pri" type="submit">Save availability</button>
          <p class="skws-msg" style="color:#9a9a9a">Private commitments and one-off blocks: use the Calendar. Buyers only ever see Available, Limited, Booked, Unavailable or Booking not open.</p></form>`;
      },
      async stats() {
        const s = await call('entAvailStats', ident);
        const k = (l, v) => `<div class="skws-kpi"><span>${esc(l)}</span><b>${esc(v)}</b></div>`;
        body.innerHTML = `<div class="skws-card"><div class="skws-msg" style="color:#9a9a9a">${esc(s.window.from)} → ${esc(s.window.to)}</div><div class="skws-grid">
          ${k('Bookings', num(s.bookings))}${k('Upcoming', num(s.upcoming))}${k('Pending payment', num(s.pending))}${k('Blocks', num(s.blocks))}
          ${k('Cancellations', num(s.cancellations))}${k('Refunds', num(s.refunds))}${k('Booked hours', num(s.bookedHours))}${k('Available hours', num(s.availableHours))}
          ${k('Utilisation', s.utilization == null ? '—' : s.utilization + '%')}${k('Repeat customers', num(s.repeatCustomers))}</div>
          ${s.advanced ? '' : '<p class="skws-plan">Utilisation, hours and repeat customers are part of Premium.</p>'}</div>`;
      },
      async ratecards() {
        const r = await call('entRateCardList', ident);
        const rows = (r.cards || []).map((c) => { const v = (c.versions || [])[0] || {};
          return `<tr><td><strong>${esc(c.name)}</strong><br><span class="skws-chip">${esc(c.visibility)}</span> <span class="skws-chip">${esc(c.segment)}</span> <span class="skws-chip">${esc(c.status)}</span></td>
          <td>${esc(kes(v.priceCents))}${v.unit && v.unit !== 'booking' ? ' / ' + esc(v.unit) : ''}<br><span style="color:#8a8a8a">v${esc(c.currentVersion)} · ${esc((c.versions || []).length)} version(s)</span></td>
          <td><button type="button" class="skws-btn" data-newver="${esc(c.id)}">New price</button>
            <button type="button" class="skws-btn" data-rcstatus="${esc(c.id)}" data-to="${c.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE'}">${c.status === 'ACTIVE' ? 'Archive' : 'Activate'}</button>
            ${c.segment !== 'PUBLIC' || c.visibility === 'PRIVATE' ? `<button type="button" class="skws-btn" data-grant="${esc(c.id)}">Grant a customer</button>` : ''}</td></tr>`; }).join('');
        body.innerHTML = `<div class="skws-card"><table class="skws-table"><thead><tr><th>Rate card</th><th>Price (current)</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="3">No rate cards yet.</td></tr>'}</tbody></table></div>
          <form class="skws-card" data-rcform><h4 style="margin:0">New rate card</h4>
          <div class="row"><label>Name<input name="name" required minlength="2" maxlength="120"></label><label>Visibility<select name="visibility"><option>PUBLIC</option><option value="ENQUIRY_ONLY">ENQUIRY ONLY</option><option value="BOOKING_ONLY">BOOKING ONLY</option><option>PRIVATE</option></select></label>
            <label>Segment<select name="segment">${['PUBLIC', 'MEMBER', 'CORPORATE', 'EVENT', 'PACKAGE', 'SEASONAL', 'PROMOTIONAL'].map((s) => `<option>${s}</option>`).join('')}</select></label></div>
          <div class="row"><label>Price (KES)<input type="number" name="price" min="0" step="1" required></label><label>Per<select name="unit"><option value="booking">booking</option><option value="hour">hour</option><option value="day">day</option></select></label>
            <label>Duration (min)<input type="number" name="durationMins" min="15"></label><label>Deposit (KES)<input type="number" name="deposit" min="0"></label></div>
          <label>Terms (cancellation / refund)<textarea name="terms" rows="2" maxlength="1000"></textarea></label>
          <button class="skws-btn pri" type="submit">Create rate card</button>
          <p class="skws-msg" style="color:#9a9a9a">A price change is a new version: confirmed bookings keep the price they were booked at.</p></form>`;
      },
      async enquiries() {
        const [l, s] = await Promise.all([call('entEnquiryList', { as: 'provider' }), call('entMessagingGetSettings', {})]);
        const tpls = Object.keys((s.settings && s.settings.templates) || {});
        const rows = (l.enquiries || []).map((e) => `<tr><td><span class="skws-chip">${esc(e.status)}</span><br>${esc((e.category || '').replace(/_/g, ' ').toLowerCase())}${e.serviceName ? ' · ' + esc(e.serviceName) : ''}</td>
          <td>${esc(e.desiredDate || '—')}<br><span style="color:#8a8a8a">${esc(when(e.createdAtMs))}</span></td>
          <td><a class="skws-btn" href="/chat.html?id=${encodeURIComponent(e.conversationId)}">Open</a>
            ${e.status === 'OPEN' ? `<button type="button" class="skws-btn" data-ack="${esc(e.id)}">Acknowledge</button>` : ''}
            ${tpls.length && !['CLOSED', 'EXPIRED', 'BLOCKED', 'CONVERTED'].includes(e.status) ? `<select data-tpl="${esc(e.id)}" style="max-width:170px"><option value="">Reply with…</option>${tpls.map((t) => `<option>${esc(t)}</option>`).join('')}</select>` : ''}
            ${!['CLOSED', 'EXPIRED', 'BLOCKED', 'CONVERTED'].includes(e.status) ? `<button type="button" class="skws-btn" data-quote="${esc(e.id)}" data-buyer="${esc(e.counterparty)}">Send quote</button>
            <button type="button" class="skws-btn" data-close="${esc(e.id)}">Close</button><button type="button" class="skws-btn" data-block="${esc(e.counterparty)}">Block user</button>` : ''}</td></tr>`).join('');
        body.innerHTML = `<div class="skws-card"><div class="row" style="margin-bottom:8px"><label>Status<select data-enqfilter><option value="">All</option>${['OPEN', 'ACKNOWLEDGED', 'RESPONDED', 'PROPOSAL_SENT', 'BOOKING_PENDING', 'CONVERTED', 'CLOSED', 'EXPIRED', 'BLOCKED'].map((x) => `<option>${x}</option>`).join('')}</select></label></div>
          <table class="skws-table"><thead><tr><th>Enquiry</th><th>Date</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="3">No enquiries yet.</td></tr>'}</tbody></table></div><div data-quoteform></div>`;
      },
      async calls() {
        const r = await call('entCallList', {});
        const rows = (r.requests || []).map((c) => `<tr><td><span class="skws-chip">${esc(c.status)}</span> ${c.mode === 'PRIVATE' ? 'Booking' : 'Enquiry'}${c.note ? '<br>' + esc(c.note) : ''}</td><td>${esc(c.scheduledFor ? when(c.scheduledFor) : when(c.createdAtMs))}</td>
          <td>${c.incoming && c.status === 'REQUESTED' ? `<button type="button" class="skws-btn pri" data-callact="accept" data-id="${esc(c.id)}">Accept</button><button type="button" class="skws-btn" data-callact="decline" data-id="${esc(c.id)}">Decline</button>
            <input type="datetime-local" data-when="${esc(c.id)}" style="max-width:220px"><button type="button" class="skws-btn" data-callact="schedule" data-id="${esc(c.id)}">Schedule</button>` : ''}</td></tr>`).join('');
        body.innerHTML = `<div class="skws-card"><table class="skws-table"><thead><tr><th>Request</th><th>When</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="3">No call requests.</td></tr>'}</tbody></table>
          <p class="skws-msg" style="color:#9a9a9a">Calls are carried by SOKONI Connect — your phone number is never shared. Accepting does not ring anyone; the call happens in the conversation.</p></div>`;
      },
      async messaging() {
        const r = await call('entMessagingGetSettings', {});
        const s = r.settings || {}; const pi = s.publicInfo || {}; const bh = (s.businessHours && s.businessHours.weekly) || [];
        const hours = DAYS.map((d, i) => { const p = (bh[i] || [])[0]; return `<div class="row"><label style="flex:0 0 110px">${d}<select name="bh_on_${i}"><option value="1" ${p ? 'selected' : ''}>Open</option><option value="0" ${p ? '' : 'selected'}>Closed</option></select></label>
          <label>From<input type="time" name="bh_from_${i}" value="${esc(p ? p.open : '09:00')}"></label><label>To<input type="time" name="bh_to_${i}" value="${esc(p ? p.close : '17:00')}"></label></div>`; }).join('');
        body.innerHTML = `<form class="skws-card" data-msgform>
          <h4 style="margin:0">Public enquiries</h4>
          <div class="row"><label>Who can message me<select name="whoCanMessage">${Object.keys(WHO).map((k) => `<option value="${k}" ${s.whoCanMessage === k ? 'selected' : ''}>${esc(WHO[k])}</option>`).join('')}</select></label>
            <label>Public enquiries<select name="enquiriesEnabled"><option value="1" ${s.enquiriesEnabled !== false ? 'selected' : ''}>On</option><option value="0" ${s.enquiriesEnabled === false ? 'selected' : ''}>Off</option></select></label>
            <label>Call requests from enquiries<select name="callRequests"><option value="DISABLED" ${s.callRequests !== 'ENABLED' ? 'selected' : ''}>Off</option><option value="ENABLED" ${s.callRequests === 'ENABLED' ? 'selected' : ''}>On (request, then you accept / schedule)</option></select></label></div>
          <label>Enquiry types you accept</label><div class="row">${CATS.map((c) => `<label style="flex:0 0 auto;display:flex;gap:6px;align-items:center"><input type="checkbox" name="cat_${c}" style="width:auto;min-height:0" ${(s.enquiryCategories || CATS).includes(c) ? 'checked' : ''}>${esc(c.replace(/_/g, ' ').toLowerCase())}</label>`).join('')}</div>
          <p class="skws-msg" style="color:#9a9a9a">Customers with a booking, payment, refund or support case always keep their booking conversation — these settings never close it.</p>
          <h4 style="margin:14px 0 6px">Business hours</h4>${hours}
          <div class="row"><label>Outside hours<select name="outsideHoursAcceptEnquiries"><option value="1" ${s.outsideHoursAcceptEnquiries !== false ? 'selected' : ''}>Still accept enquiries</option><option value="0" ${s.outsideHoursAcceptEnquiries === false ? 'selected' : ''}>Do not accept</option></select></label>
            <label>Typical response time<select name="responseTime">${Object.keys(RESP).map((k) => `<option value="${k}" ${String(s.responseTime || '') === k ? 'selected' : ''}>${esc(RESP[k])}</option>`).join('')}</select></label>
            <label>Custom response time<input name="responseTimeCustom" maxlength="80" value="${esc(s.responseTimeCustom || '')}"></label></div>
          <h4 style="margin:14px 0 6px">Public information (shown before "Send enquiry")</h4>
          ${['serviceDescription', 'location', 'availabilityPolicy', 'cancellationPolicy', 'bookingRequirements', 'minimumNotice'].map((k) => `<label>${esc(k.replace(/([A-Z])/g, ' $1').toLowerCase())}<textarea name="pi_${k}" rows="2" maxlength="1000">${esc(pi[k] || '')}</textarea></label>`).join('')}
          <label>Pricing from (KES)<input type="number" name="pi_pricingFrom" min="0" value="${pi.pricingFromCents != null ? esc(pi.pricingFromCents / 100) : ''}"></label>
          <label>FAQs — one per line, "question | answer"<textarea name="faqs" rows="3">${esc((pi.faqs || []).map((f) => f.q + ' | ' + f.a).join('\n'))}</textarea></label>
          <h4 style="margin:14px 0 6px">Quick responses</h4><p class="skws-msg" style="color:#9a9a9a">A quick response may not say a payment, booking or refund is complete — SOKONI posts those from the real state.</p>
          ${TPL.map((t) => `<label>${esc(t.replace(/_/g, ' ').toLowerCase())}<textarea name="tpl_${t}" rows="2" maxlength="1000">${esc((s.templates || {})[t] || '')}</textarea></label>`).join('')}
          <button class="skws-btn pri" type="submit">Save message settings</button></form>`;
      },
      async discounts() {
        const r = await call('entDiscountList', {});
        const rows = (r.discounts || []).map((d) => `<tr><td><strong>${esc(d.code)}</strong><br>${esc(d.campaign)}</td><td>${d.type === 'percent' ? esc(d.value) + '%' : 'KES ' + esc(d.value)}${d.maxDiscount != null ? ' (max KES ' + esc(d.maxDiscount) + ')' : ''}</td>
          <td>${esc(num(d.usedCount))} / ${esc(num(d.usageLimit))}<br><span style="color:#8a8a8a">until ${esc(when(d.validTo))}</span></td><td><span class="skws-chip">${esc(d.status)}</span> ${d.status === 'active' ? `<button type="button" class="skws-btn" data-disc="${esc(d.id)}">Disable</button>` : ''}</td></tr>`).join('');
        body.innerHTML = `<div class="skws-card"><table class="skws-table"><thead><tr><th>Code</th><th>Discount</th><th>Used</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="4">No discount codes.</td></tr>'}</tbody></table></div>
          <form class="skws-card" data-discform><h4 style="margin:0">New discount (Marketing)</h4>
          <div class="row"><label>Code<input name="code" required minlength="4" maxlength="32"></label><label>Campaign<input name="campaign" required minlength="2" maxlength="80" placeholder="e.g. October availability"></label></div>
          <div class="row"><label>Type<select name="type"><option value="percent">Percent</option><option value="flat">Fixed KES</option></select></label><label>Value<input type="number" name="value" min="1" required></label>
            <label>Max discount (KES)<input type="number" name="maxDiscount" min="0"></label><label>Usage limit<input type="number" name="usageLimit" min="1" required></label><label>Valid until<input type="date" name="validTo" required></label></div>
          <button class="skws-btn pri" type="submit">Create discount</button><p class="skws-msg" style="color:#9a9a9a">The server applies the discount at checkout; a buyer can never set their own.</p></form>`;
      },
    };

    async function render() {
      host.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === section));
      if (cal) { cal.destroy(); cal = null; }
      body.innerHTML = '<div class="skws-msg">Loading…</div>';
      try { await R[section](); } catch (e) { body.innerHTML = `<div class="skws-card skws-err">${esc((e && e.message) || 'Could not load.')}</div>`; }
    }

    host.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.tab) { section = b.dataset.tab; msg(''); return render(); }
      if (b.dataset.newver) { const p = prompt('New price in KES (confirmed bookings keep their old price):'); if (p) return act('entRateCardNewVersion', { cardId: b.dataset.newver, version: { priceCents: Math.round(Number(p) * 100) } }, 'New price version saved.'); return undefined; }
      if (b.dataset.rcstatus) return act('entRateCardUpdate', { cardId: b.dataset.rcstatus, status: b.dataset.to });
      if (b.dataset.grant) { const u = prompt('Customer account id to allow this rate:'); if (u) return act('entRateCardGrant', { cardId: b.dataset.grant, uid: u.trim() }, 'Customer allowed.'); return undefined; }
      if (b.dataset.ack) return act('entEnquiryAcknowledge', { enquiryId: b.dataset.ack }, 'Acknowledged.');
      if (b.dataset.close) return act('entEnquiryClose', { enquiryId: b.dataset.close }, 'Closed.');
      if (b.dataset.block) { if (confirm('Block this user from PUBLIC enquiries? Existing bookings are not affected.')) return act('entEnquiryBlockUser', { uid: b.dataset.block }, 'Blocked from public enquiries.'); return undefined; }
      if (b.dataset.quote) {
        const box = body.querySelector('[data-quoteform]');
        box.innerHTML = `<form class="skws-card" data-qform data-enq="${esc(b.dataset.quote)}" data-buyer="${esc(b.dataset.buyer)}"><h4 style="margin:0">Quote</h4>
          <label>Description<textarea name="description" rows="2" required maxlength="1000"></textarea></label>
          <div class="row"><label>Price (KES)<input type="number" name="price" min="1" required></label><label>Discount (KES)<input type="number" name="discount" min="0" value="0"></label>
            <label>Date<input type="date" name="date"></label><label>Time<input type="time" name="time"></label><label>Duration (min)<input type="number" name="duration" min="15"></label><label>Valid (days)<input type="number" name="days" min="1" max="30" value="7"></label></div>
          <label>Cancellation / refund terms<textarea name="terms" rows="2" maxlength="1000"></textarea></label>
          <button class="skws-btn pri" type="submit">Send quote</button></form>`;
        box.scrollIntoView({ behavior: 'smooth' });
        return undefined;
      }
      if (b.dataset.callact) {
        const data = { requestId: b.dataset.id, action: b.dataset.callact };
        if (b.dataset.callact === 'schedule') { const w = body.querySelector(`[data-when="${b.dataset.id}"]`); if (!w || !w.value) return msg('Choose a time first.', true); data.atMs = new Date(w.value + ':00+03:00').getTime(); }
        return act('entCallRespond', data, 'Done.');
      }
      if (b.dataset.disc) return act('entDiscountDisable', { couponId: b.dataset.disc }, 'Disabled.');
      return undefined;
    });
    host.addEventListener('change', (ev) => {
      if (ev.target.dataset.tpl && ev.target.value) act('entEnquiryReply', { enquiryId: ev.target.dataset.tpl, template: ev.target.value }, 'Sent.');
      if (ev.target.matches('[data-enqfilter]')) { const v = ev.target.value; body.querySelectorAll('tbody tr').forEach((tr) => { tr.hidden = !!v && !tr.textContent.includes(v); }); }
    });
    host.addEventListener('submit', (ev) => {
      const f = ev.target; ev.preventDefault();
      const n = (k) => (f[k] && f[k].value !== '' ? Number(f[k].value) : null);
      if (f.matches('[data-avform]')) {
        const weekly = DAYS.map((_, i) => (f['open_' + i].value === '1' ? [{ open: f['from_' + i].value, close: f['to_' + i].value }] : []));
        return act('entAvailSetConfig', Object.assign({}, ident, { config: { weekly, durationMins: n('durationMins'), stepMins: n('stepMins'), minNoticeHours: n('minNoticeHours'), horizonDays: n('horizonDays'),
          bufferBeforeMins: n('bufferBeforeMins'), bufferAfterMins: n('bufferAfterMins'), capacity: n('capacity'), maxPerDay: n('maxPerDay'), allowSameDay: f.allowSameDay.value === '1',
          reopenAfterCancel: f.reopenAfterCancel.value === '1', cooldownMins: n('cooldownMins'), closedDates: f.closedDates.value.split(/\s+/).filter(Boolean) } }), 'Availability saved — the storefront updates automatically.');
      }
      if (f.matches('[data-rcform]')) {
        return act('entRateCardCreate', Object.assign({}, ident, { name: f.name.value, visibility: f.visibility.value, segment: f.segment.value,
          version: { priceCents: Math.round(Number(f.price.value) * 100), unit: f.unit.value, durationMins: n('durationMins'), depositCents: f.deposit.value ? Math.round(Number(f.deposit.value) * 100) : null, terms: f.terms.value } }), 'Rate card created.');
      }
      if (f.matches('[data-qform]')) {
        return act('entQuoteCreate', Object.assign({}, ident, { enquiryId: f.dataset.enq, buyerUid: f.dataset.buyer, description: f.description.value, priceCents: Math.round(Number(f.price.value) * 100),
          discountCents: Math.round(Number(f.discount.value || 0) * 100), date: f.date.value || null, startTime: f.time.value || null, durationMins: n('duration'), validDays: n('days'), terms: f.terms.value }), 'Quote sent into the enquiry.');
      }
      if (f.matches('[data-msgform]')) {
        const bh = DAYS.map((_, i) => (f['bh_on_' + i].value === '1' ? [{ open: f['bh_from_' + i].value, close: f['bh_to_' + i].value }] : []));
        const templates = {}; TPL.forEach((t) => { if (f['tpl_' + t].value.trim()) templates[t] = f['tpl_' + t].value.trim(); });
        const publicInfo = {}; ['serviceDescription', 'location', 'availabilityPolicy', 'cancellationPolicy', 'bookingRequirements', 'minimumNotice'].forEach((k) => { publicInfo[k] = f['pi_' + k].value; });
        if (f.pi_pricingFrom.value !== '') publicInfo.pricingFromCents = Math.round(Number(f.pi_pricingFrom.value) * 100);
        publicInfo.faqs = f.faqs.value.split('\n').map((l) => l.split('|')).filter((p) => p.length >= 2).map((p) => ({ q: p[0].trim(), a: p.slice(1).join('|').trim() }));
        return act('entMessagingSetSettings', { settings: { whoCanMessage: f.whoCanMessage.value, enquiriesEnabled: f.enquiriesEnabled.value === '1', callRequests: f.callRequests.value,
          enquiryCategories: CATS.filter((c) => f['cat_' + c].checked), businessHours: { weekly: bh }, outsideHoursAcceptEnquiries: f.outsideHoursAcceptEnquiries.value === '1',
          responseTime: f.responseTime.value || null, responseTimeCustom: f.responseTimeCustom.value || null, publicInfo, templates } }, 'Message settings saved.');
      }
      if (f.matches('[data-discform]')) {
        return act('entDiscountCreate', Object.assign({}, ident, { code: f.code.value, campaign: f.campaign.value, type: f.type.value, value: Number(f.value.value), maxDiscount: n('maxDiscount'),
          usageLimit: n('usageLimit'), validTo: new Date(f.validTo.value + 'T23:59:59+03:00').getTime() }), 'Discount created.');
      }
      return undefined;
    });

    render();
    return { show(s) { section = s; return render(); }, destroy() { if (cal) cal.destroy(); host.innerHTML = ''; } };
  }

  root.SokoniEntWorkspace = { mount, TABS };
}(typeof window !== 'undefined' ? window : globalThis));
