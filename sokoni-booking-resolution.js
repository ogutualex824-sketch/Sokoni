/* ============================================================================
   SOKONI — Booking Resolution UI (shared)   sokoni-booking-resolution.js
   Step 2b: renders the affected-booking resolution workflow + negotiation timeline
   for BOTH the customer (My Bookings) and the provider (dashboard). Uses ONLY the
   already-deployed providerDispatch ops — no new booking logic here.

   Usage:  <div id="skResolution"></div>
           <script src="sokoni-booking-resolution.js" defer></script>
           SokoniResolution.mount({ role: 'customer'|'provider', containerId: 'skResolution' });
   ========================================================================== */
(function () {
  'use strict';

  /* Prefer the modular bridge (firebase.js publishes window.sokoniCallable); fall back to the
     compat SDK (provider-dashboard). Returns the callable's .data payload. */
  function _dispatch(payload) {
    if (typeof window.sokoniCallable === 'function') {
      return window.sokoniCallable('providerDispatch')(payload).then(function (r) { return (r && r.data) || r; });
    }
    if (window.firebase && window.firebase.functions) {
      return window.firebase.functions().httpsCallable('providerDispatch')(payload).then(function (r) { return r.data; });
    }
    return Promise.reject(new Error('No callable bridge available.'));
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function _toast(msg, ok) {
    if (typeof window.showToast === 'function') { window.showToast(msg, !ok); return; }
    if (typeof window.toast === 'function') { window.toast(msg, ok ? 'ok' : 'err'); return; }
    try { console.log('[resolution]', msg); } catch (e) {}
  }

  var EVENT_LABEL = {
    BOOKING_AFFECTED: 'Booking affected by an availability change',
    AVAILABILITY_CHANGED: 'Provider changed availability',
    CUSTOMER_NOTIFIED: 'Customer notified',
    PROVIDER_PROPOSED_RESCHEDULE: 'Provider proposed a new time',
    CUSTOMER_PROPOSED_TIME: 'Customer suggested a new time',
    CUSTOMER_ACCEPTED: 'Customer accepted',
    CUSTOMER_DECLINED: 'Customer declined',
    PROVIDER_ACCEPTED_TIME: 'Provider accepted the time',
    PROVIDER_DECLINED: 'Provider declined',
    BOOKING_RESCHEDULED: 'Booking rescheduled',
    BOOKING_CANCELLED: 'Booking cancelled',
    REFUND_COMPLETED: 'Refund completed',
  };
  var BTN = 'padding:8px 12px;border-radius:9px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;border:1px solid rgba(255,255,255,.14);';
  var BTN_P = 'padding:8px 12px;border-radius:9px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;border:none;background:#71ff00;color:#04120a;';
  var BTN_D = 'padding:8px 12px;border-radius:9px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;border:1px solid rgba(255,84,112,.4);background:rgba(255,84,112,.08);color:#ff8098;';

  /* Promise<{date,startTime}|null> — a compact date+time picker. The op re-validates against
     the canonical availability, so an unavailable choice is rejected server-side. */
  function _pickTime(title) {
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px;';
      var today = '';
      try { today = new Date(Date.now() + 86400000).toISOString().slice(0, 10); } catch (e) {}
      back.innerHTML =
        '<div style="background:#0f0f0f;border:1px solid rgba(255,255,255,.12);border-radius:16px;max-width:380px;width:100%;padding:20px;color:#fff;font-family:inherit;">' +
          '<div style="font-size:15px;font-weight:800;margin-bottom:14px;">' + esc(title) + '</div>' +
          '<label style="font-size:11px;font-weight:700;color:rgba(255,255,255,.55);">Date</label>' +
          '<input id="_rtDate" type="date" min="' + today + '" value="' + today + '" style="width:100%;margin:6px 0 12px;padding:11px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:10px;color:#fff;font-size:15px;font-family:inherit;">' +
          '<label style="font-size:11px;font-weight:700;color:rgba(255,255,255,.55);">Start time</label>' +
          '<input id="_rtTime" type="time" value="10:00" style="width:100%;margin:6px 0 16px;padding:11px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:10px;color:#fff;font-size:15px;font-family:inherit;">' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
            '<button id="_rtCancel" style="' + BTN + 'background:rgba(255,255,255,.06);color:#fff;">Cancel</button>' +
            '<button id="_rtOk" style="' + BTN_P + '">Propose</button>' +
          '</div></div>';
      document.body.appendChild(back);
      var done = function (v) { back.remove(); resolve(v); };
      back.querySelector('#_rtCancel').onclick = function () { done(null); };
      back.querySelector('#_rtOk').onclick = function () {
        var d = back.querySelector('#_rtDate').value, t = back.querySelector('#_rtTime').value;
        if (!d || !t) return;
        done({ date: d, startTime: t });
      };
      back.addEventListener('click', function (e) { if (e.target === back) done(null); });
    });
  }

  function _proposalLine(p) {
    if (!p) return '';
    var who = p.by === 'provider' ? 'Provider proposed' : 'You/customer suggested';
    return '<div style="font-size:12px;color:#71ff00;font-weight:700;margin-top:2px;">' + who + ': ' + esc(p.date) + ' ' + esc(p.startTime) + '</div>';
  }

  function _actionsHtml(it, role) {
    var p = it.proposal, id = esc(it.bookingId);
    var A = [];
    if (role === 'customer') {
      if (p && p.by === 'provider' && p.status === 'pending_customer') {
        A.push('<button data-act="cust-accept" data-id="' + id + '" style="' + BTN_P + '">Accept</button>');
        A.push('<button data-act="cust-decline" data-id="' + id + '" style="' + BTN_D + '">Decline</button>');
        A.push('<button data-act="cust-suggest" data-id="' + id + '" style="' + BTN + 'background:rgba(255,255,255,.05);color:#fff;">Suggest another time</button>');
      } else if (p && p.by === 'customer' && p.status === 'pending_provider') {
        A.push('<span style="font-size:12px;color:rgba(255,255,255,.55);">Waiting for provider response…</span>');
      } else {
        A.push('<span style="font-size:12px;color:rgba(255,255,255,.55);">The provider will propose a new time — or</span>');
        A.push('<button data-act="cust-suggest" data-id="' + id + '" style="' + BTN + 'background:rgba(255,255,255,.05);color:#fff;">Suggest a time</button>');
      }
      A.push('<button data-act="cust-refund" data-id="' + id + '" style="' + BTN + 'background:transparent;color:#ff8098;border-color:rgba(255,84,112,.35);">Request refund</button>');
    } else { /* provider */
      if (p && p.by === 'customer' && p.status === 'pending_provider') {
        A.push('<button data-act="prov-accept" data-id="' + id + '" style="' + BTN_P + '">Accept customer’s time</button>');
        A.push('<button data-act="prov-decline" data-id="' + id + '" style="' + BTN_D + '">Decline</button>');
      } else if (p && p.by === 'provider' && p.status === 'pending_customer') {
        A.push('<span style="font-size:12px;color:rgba(255,255,255,.55);">Waiting for customer response…</span>');
      } else {
        A.push('<button data-act="prov-propose" data-id="' + id + '" style="' + BTN_P + '">Propose new time</button>');
      }
    }
    A.push('<button data-act="history" data-id="' + id + '" style="' + BTN + 'background:transparent;color:rgba(255,255,255,.6);">History</button>');
    return A.join(' ');
  }

  function _card(it, role) {
    var id = esc(it.bookingId);
    return '<div data-card="' + id + '" style="background:rgba(255,84,112,.06);border:1px solid rgba(255,84,112,.25);border-radius:14px;padding:14px;margin-bottom:10px;">' +
      '<div style="font-size:13px;font-weight:800;color:#fff;">' + esc(it.service || 'Service') + '</div>' +
      '<div style="font-size:12px;color:rgba(255,255,255,.55);">Originally ' + esc(it.date || '') + ' ' + esc(it.startTime || '') + '</div>' +
      _proposalLine(it.proposal) +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center;">' + _actionsHtml(it, role) + '</div>' +
      '<div data-tl="' + id + '" style="display:none;margin-top:12px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px;"></div>' +
    '</div>';
  }

  async function _showTimeline(id, host) {
    var box = host.querySelector('[data-tl="' + id + '"]');
    if (!box) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.innerHTML = '<div style="font-size:12px;color:rgba(255,255,255,.4);">Loading timeline…</div>';
    try {
      var r = await _dispatch({ op: 'bookingGetTimeline', bookingId: id });
      var evs = (r && r.events) || [];
      box.innerHTML = evs.map(function (e) {
        return '<div style="font-size:12px;color:rgba(255,255,255,.7);margin:3px 0;">✓ ' + esc(EVENT_LABEL[e.type] || e.type) +
          (e.data && e.data.date ? ' <span style="color:#71ff00;">(' + esc(e.data.date) + ' ' + esc(e.data.startTime || '') + ')</span>' : '') + '</div>';
      }).join('') || '<div style="font-size:12px;color:rgba(255,255,255,.4);">No history yet.</div>';
    } catch (e) { box.innerHTML = '<div style="font-size:12px;color:rgba(255,255,255,.4);">Couldn’t load history.</div>'; }
  }

  async function _act(act, id, role, host) {
    try {
      if (act === 'history') { return _showTimeline(id, host); }
      if (act === 'cust-accept') { await _dispatch({ op: 'customerRespondToProposal', bookingId: id, action: 'accept' }); _toast('Accepted — your booking was rescheduled.', true); }
      else if (act === 'cust-decline') { await _dispatch({ op: 'customerRespondToProposal', bookingId: id, action: 'decline' }); _toast('Declined. The provider can propose another time.', true); }
      else if (act === 'prov-accept') { await _dispatch({ op: 'providerRespondToCustomerProposal', bookingId: id, action: 'accept' }); _toast('Accepted — booking rescheduled.', true); }
      else if (act === 'prov-decline') { await _dispatch({ op: 'providerRespondToCustomerProposal', bookingId: id, action: 'decline' }); _toast('Declined.', true); }
      else if (act === 'cust-refund') {
        if (!window.confirm('Request a refund? Your booking will be cancelled and the amount refunded to your SOKONI wallet. This cannot be undone.')) return;
        await _dispatch({ op: 'customerRequestRefund', bookingId: id }); _toast('Refund completed — your booking was cancelled.', true);
      }
      else if (act === 'cust-suggest' || act === 'prov-propose') {
        var t = await _pickTime(act === 'prov-propose' ? 'Propose a new time' : 'Suggest a time');
        if (!t) return;
        var op = act === 'prov-propose' ? 'providerProposeReschedule' : 'customerProposeTime';
        await _dispatch({ op: op, bookingId: id, date: t.date, startTime: t.startTime });
        _toast('Proposed ' + t.date + ' ' + t.startTime + ' — the other party was notified.', true);
      }
      mount({ role: role, containerId: host.id });   // refresh
    } catch (e) {
      var m = (e && (e.message || (e.details && e.details.message))) || 'Action failed.';
      _toast(m.replace(/^.*?:\s*/, ''), false);
    }
  }

  function _wire(host, role) {
    host.querySelectorAll('button[data-act]').forEach(function (btn) {
      btn.onclick = function () { _act(btn.getAttribute('data-act'), btn.getAttribute('data-id'), role, host); };
    });
  }

  async function mount(opts) {
    opts = opts || {};
    var role = opts.role === 'provider' ? 'provider' : 'customer';
    var host = document.getElementById(opts.containerId);
    if (!host) return;
    try {
      var res = await _dispatch({ op: role === 'provider' ? 'providerListAffectedBookings' : 'customerListAffectedBookings' });
      var items = (res && res.items) || [];
      if (!items.length) { host.style.display = 'none'; host.innerHTML = ''; return; }
      host.style.display = '';
      host.innerHTML = '<div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#ff5470;margin:0 0 10px;">⚠ Action required — ' + items.length + ' booking' + (items.length > 1 ? 's' : '') + '</div>' +
        items.map(function (it) { return _card(it, role); }).join('');
      _wire(host, role);
    } catch (e) {
      /* ops not deployed / offline / not signed in → render nothing (no regression) */
      host.style.display = 'none';
    }
  }

  window.SokoniResolution = { mount: mount };
})();
