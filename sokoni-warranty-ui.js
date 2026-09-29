/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — WARRANTY & RETURNS (client)
   sokoni-warranty-ui.js

   Two surfaces, one vocabulary: the seller's policy builder in Merchant V2 and the buyer's
   protection panel with its return sheet.

   ── ONE VOCABULARY, MIRRORED FROM THE SERVER ──────────────────────────────────
   The remedy and reason KEYS here are exactly those in functions/warranty-policy.js, and
   certification compares the two lists rather than trusting this comment. A seller offered
   a remedy the server drops would be promising something no buyer can ever claim; a buyer
   shown a reason the server refuses would be invited to fill in a form that was always
   going to be rejected.

   ── IT DECIDES NOTHING ────────────────────────────────────────────────────────
   No window arithmetic, no fault attribution, no liability, no refund amount. The seller's
   builder collects a policy and the server validates it; the buyer's panel renders what
   warrantyForOrder returned and the sheet renders the options that came with it. The one
   thing this module must never do is compute money, and there is no code here that could.

   ── SELECTABLE TILES, NOT CHECKBOXES ──────────────────────────────────────────
   A policy is a promise a seller is making, and a row of grey checkboxes reads like a
   settings screen nobody finishes. Tiles with a clear selected state, and a live preview of
   exactly what the buyer will see, so the seller is looking at the promise rather than at
   the form that captures it.
   ══════════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ── THE VOCABULARY ─────────────────────────────────────────────────────── */

  var DURATIONS = [
    { days: 0,  label: 'No warranty', sub: 'Sold as seen' },
    { days: 1,  label: '1 day' },
    { days: 3,  label: '3 days' },
    { days: 7,  label: '7 days' },
    { days: 14, label: '14 days' },
    { days: 30, label: '30 days' },
    { days: 60, label: '60 days' },
    { days: 90, label: '90 days' },
  ];

  var REMEDIES = [
    { key: 'refund',       icon: '💵', label: 'Refund',       sub: 'Money back' },
    { key: 'replacement',  icon: '📦', label: 'Replacement',  sub: 'Same item again' },
    { key: 'repair',       icon: '🔧', label: 'Repair',       sub: 'You fix it' },
    { key: 'exchange',     icon: '🔁', label: 'Exchange',     sub: 'A different item' },
    { key: 'store_credit', icon: '🎟️', label: 'Store credit', sub: 'Spend it with you' },
  ];

  /* `fault` mirrors the server's attribution and is shown to the SELLER so they can see
     what they are agreeing to — the buyer's liability is always read from the server's own
     answer, never from this table. */
  var REASONS = [
    { key: 'wrong_product',    icon: '📦', label: 'Wrong product',           fault: 'seller' },
    { key: 'damaged',          icon: '💥', label: 'Damaged',                 fault: 'seller' },
    { key: 'defective',        icon: '⚙️', label: 'Defective',               fault: 'seller' },
    { key: 'missing_item',     icon: '🕳️', label: 'Missing item',            fault: 'seller' },
    { key: 'not_as_described', icon: '📝', label: "Doesn't match description", fault: 'seller' },
    { key: 'wrong_variant',    icon: '🎨', label: 'Wrong size / colour / model', fault: 'seller' },
    { key: 'incomplete_order', icon: '📋', label: 'Incomplete order',        fault: 'seller' },
    { key: 'other',            icon: '•',  label: 'Other',                   fault: 'review' },
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function labelOf(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i].label;
    return key;
  }
  function iconOf(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i].icon || '';
    return '';
  }

  /* ── 1. THE SELLER'S BUILDER ────────────────────────────────────────────── */

  function tile(kind, key, on, icon, label, sub) {
    return '<button type="button" class="wty-tile' + (on ? ' is-on' : '') + '" ' +
      'data-wty="' + esc(kind) + '" data-key="' + esc(key) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
      (icon ? '<span class="wty-tile-ico" aria-hidden="true">' + esc(icon) + '</span>' : '') +
      '<span class="wty-tile-l">' + esc(label) + '</span>' +
      (sub ? '<span class="wty-tile-s">' + esc(sub) + '</span>' : '') +
      '<span class="wty-tile-tick" aria-hidden="true"></span>' +
      '</button>';
  }

  /** Normalise whatever the product currently stores into the builder's state. */
  function readPolicy(p) {
    var w = p || {};
    return {
      durationDays: Number.isFinite(Number(w.durationDays)) ? Number(w.durationDays) : null,
      remedies: Array.isArray(w.remedies) ? w.remedies.slice() : [],
      reasons: Array.isArray(w.reasons) ? w.reasons.slice() : [],
      custom: !!w.custom,
    };
  }

  /**
   * The builder. `policy` is what the product stores today.
   *
   * A duration of 0 is a real answer — "sold as seen" — and is offered as its own tile so a
   * seller can state it rather than leaving the section blank and meaning nothing in
   * particular.
   */
  function policyBuilderHTML(policy) {
    var P = readPolicy(policy);
    var none = P.durationDays === 0;
    var custom = P.custom || (P.durationDays != null && P.durationDays > 0 &&
      !DURATIONS.some(function (d) { return d.days === P.durationDays; }));

    var durations = DURATIONS.map(function (d) {
      return tile('duration', String(d.days), P.durationDays === d.days && !custom,
                  '', d.label, d.sub || '');
    }).join('') +
      tile('duration', 'custom', custom, '', 'Custom', 'Set your own');

    var remedies = REMEDIES.map(function (r) {
      return tile('remedy', r.key, P.remedies.indexOf(r.key) > -1, r.icon, r.label, r.sub);
    }).join('');

    var reasons = REASONS.map(function (r) {
      return tile('reason', r.key, P.reasons.indexOf(r.key) > -1, r.icon, r.label, '');
    }).join('');

    return '' +
      '<section class="wty-build" data-wty-root>' +
        '<div class="wty-head">' +
          '<span class="wty-head-ico" aria-hidden="true">🛡</span>' +
          '<span><b>Warranty &amp; Returns</b>' +
          '<span class="wty-head-sub">What you promise the buyer on this product.</span></span>' +
        '</div>' +

        '<div class="wty-group"><div class="wty-glabel">How long is it protected?</div>' +
          '<div class="wty-tiles wty-dur">' + durations + '</div>' +
          '<div class="wty-custom"' + (custom ? '' : ' hidden') + '>' +
            '<label class="wty-clabel" for="wty-custom-days">Days</label>' +
            '<input class="wty-cinput" id="wty-custom-days" data-wty="customDays" ' +
              'type="number" inputmode="numeric" min="1" max="3650" step="1" ' +
              'value="' + esc(custom && P.durationDays != null ? P.durationDays : '') + '">' +
          '</div>' +
        '</div>' +

        '<div class="wty-group"' + (none ? ' hidden' : '') + ' data-wty-when="protected">' +
          '<div class="wty-glabel">What can the buyer request?</div>' +
          '<div class="wty-tiles">' + remedies + '</div>' +
        '</div>' +

        '<div class="wty-group"' + (none ? ' hidden' : '') + ' data-wty-when="protected">' +
          '<div class="wty-glabel">Eligible reasons</div>' +
          '<div class="wty-tiles">' + reasons + '</div>' +
          /* The seller is told which reasons put the return delivery on them, at the moment
             they are choosing — not in a policy document they will never read again. */
          '<div class="wty-note">Reasons marked <b>seller fault</b> mean you cover the return ' +
          'delivery. The buyer did not cause those.</div>' +
        '</div>' +

        '<div class="wty-preview" data-wty-preview>' + previewHTML(P) + '</div>' +
      '</section>';
  }

  /**
   * What the buyer will see, rendered from the seller's current selection.
   *
   * The preview is the point of the builder: a seller reading a form cannot tell whether
   * they have promised anything useful, and a seller reading their own promise can.
   */
  function previewHTML(P) {
    var p = readPolicy(P);
    if (p.durationDays === 0) {
      return '<div class="wty-pv"><div class="wty-pv-h">The buyer will see</div>' +
        '<div class="wty-pv-none">No warranty on this product — sold as seen.</div></div>';
    }
    if (p.durationDays == null) {
      return '<div class="wty-pv"><div class="wty-pv-h">The buyer will see</div>' +
        '<div class="wty-pv-none">Nothing yet — choose how long it is protected.</div></div>';
    }
    var incomplete = !p.remedies.length || !p.reasons.length;
    return '<div class="wty-pv">' +
      '<div class="wty-pv-h">The buyer will see</div>' +
      '<div class="wty-pv-days">Protected for ' + esc(p.durationDays) + ' day' +
        (p.durationDays === 1 ? '' : 's') + '</div>' +
      '<div class="wty-pv-start">Protection starts when the order is delivered</div>' +
      (p.remedies.length
        ? '<div class="wty-pv-list">' + p.remedies.map(function (k) {
            return '<span>✓ ' + esc(labelOf(REMEDIES, k)) + '</span>'; }).join('') + '</div>'
        : '') +
      (p.reasons.length
        ? '<div class="wty-pv-sub">Eligible reasons</div><div class="wty-pv-list">' +
          p.reasons.map(function (k) {
            return '<span>✓ ' + esc(labelOf(REASONS, k)) + '</span>'; }).join('') + '</div>'
        : '') +
      (incomplete
        /* Said plainly rather than saved quietly: the server refuses a policy that offers
           nothing, and a seller who does not know that will think they are protected. */
        ? '<div class="wty-pv-warn">Choose at least one request and one reason, or this ' +
          'product will have no warranty at all.</div>'
        : '') +
      '</div>';
  }

  /**
   * Read the builder back out of the DOM.
   *
   * From what is ON SCREEN, which is what the seller believes they are saving — the same
   * reason the product form reads its own nested fields from the document rather than from
   * an internal shadow copy that can drift.
   */
  function readBuilder(host) {
    if (!host) return null;
    var root = host.querySelector('[data-wty-root]');
    if (!root) return null;

    var picked = function (kind) {
      return Array.prototype.slice.call(
        root.querySelectorAll('[data-wty="' + kind + '"][aria-pressed="true"]')
      ).map(function (b) { return b.getAttribute('data-key'); });
    };

    var dur = picked('duration')[0];
    var days = null;
    if (dur === 'custom') {
      var el = root.querySelector('[data-wty="customDays"]');
      var n = el ? Number(el.value) : NaN;
      days = Number.isFinite(n) ? Math.round(n) : null;
    } else if (dur != null) {
      days = Number(dur);
    }

    if (days === null) return null;                 /* nothing chosen — nothing promised */
    if (days === 0) return { durationDays: 0, remedies: [], reasons: [], startsAt: 'delivery' };

    return {
      durationDays: days,
      remedies: picked('remedy'),
      reasons: picked('reason'),
      /* THE ANCHOR IS NOT THE SELLER'S TO CHOOSE. Protection starts when the buyer has the
         goods; a purchase anchor would let a slow dispatch shorten what was promised. */
      startsAt: 'delivery',
    };
  }

  /** Wire the tiles. Returns a teardown. */
  function mountPolicyBuilder(host, opts) {
    if (!host) return function () {};
    var o = opts || {};

    function repaint() {
      var root = host.querySelector('[data-wty-root]');
      if (!root) return;
      var pv = root.querySelector('[data-wty-preview]');
      var read = readBuilder(host);
      if (pv) pv.innerHTML = previewHTML(read || {});
      var none = read && read.durationDays === 0;
      Array.prototype.forEach.call(root.querySelectorAll('[data-wty-when="protected"]'),
        function (el) { el.hidden = !!none; });
      var custom = root.querySelector('.wty-custom');
      var chosen = root.querySelector('[data-wty="duration"][aria-pressed="true"]');
      if (custom) custom.hidden = !(chosen && chosen.getAttribute('data-key') === 'custom');
      if (typeof o.onChange === 'function') o.onChange(read);
    }

    function onClick(e) {
      var t = e.target && e.target.closest && e.target.closest('[data-wty]');
      if (!t || !host.contains(t)) return;
      var kind = t.getAttribute('data-wty');
      if (kind !== 'duration' && kind !== 'remedy' && kind !== 'reason') return;
      e.preventDefault();

      if (kind === 'duration') {
        /* One duration. A policy with two lengths is not a policy. */
        Array.prototype.forEach.call(host.querySelectorAll('[data-wty="duration"]'), function (b) {
          b.setAttribute('aria-pressed', 'false'); b.classList.remove('is-on');
        });
        t.setAttribute('aria-pressed', 'true'); t.classList.add('is-on');
      } else {
        var on = t.getAttribute('aria-pressed') !== 'true';
        t.setAttribute('aria-pressed', on ? 'true' : 'false');
        t.classList.toggle('is-on', on);
      }
      repaint();
    }

    host.addEventListener('click', onClick);
    host.addEventListener('input', repaint);
    repaint();
    return function () {
      host.removeEventListener('click', onClick);
      host.removeEventListener('input', repaint);
    };
  }

  /* ── 2. THE BUYER'S PROTECTION PANEL ────────────────────────────────────── */

  /**
   * `view` is exactly what warrantyForOrder returned. Nothing is recomputed.
   */
  function warrantyPanelHTML(view) {
    if (!view || !view.ok) return '';
    var w = view.warranty || {};
    if (!w.pinned) {
      /* NOT "no warranty". Nothing has been recorded yet, and an expired shield here would
         tell the buyer something false about their own purchase. */
      return '<section class="wty-panel"><div class="wty-head">' +
        '<span class="wty-head-ico">🛡</span><span><b>Warranty &amp; Returns</b></span></div>' +
        '<div class="wty-empty">Protection for this order has not been recorded yet.</div>' +
        '</section>';
    }

    var lines = (w.lines || []).map(function (l) { return lineHTML(l, view); }).join('');
    return '<section class="wty-panel">' +
      '<div class="wty-head"><span class="wty-head-ico" aria-hidden="true">🛡</span>' +
        '<span><b>Warranty &amp; Returns</b>' +
        '<span class="wty-head-sub">Your purchase protection</span></span></div>' +
      lines +
      '</section>';
  }

  function lineHTML(l, view) {
    var name = l.productName || 'This item';
    if (!l.protected) {
      return '<article class="wty-line">' +
        '<div class="wty-line-h">' + esc(name) + '</div>' +
        '<div class="wty-empty">This seller offers no returns on this item.</div>' +
        '</article>';
    }

    var win = l.window || {};
    var state = win.state;
    var remedies = (l.remedies || []).map(function (k) {
      return '<span class="wty-chip">✓ ' + esc(labelOf(REMEDIES, k)) + '</span>'; }).join('');
    var reasons = (l.reasons || []).map(function (r) {
      return '<span class="wty-chip">✓ ' + esc(r.label || labelOf(REASONS, r.key)) + '</span>'; }).join('');

    /* THE TIME REMAINING IS THE SERVER'S. Recomputing it here would let a clock-skewed phone
       tell a buyer their protection had run out a day early. */
    var clock =
      state === 'ACTIVE' ? '<div class="wty-clock is-live">' +
          esc(win.daysRemaining) + ' day' + (win.daysRemaining === 1 ? '' : 's') + ' remaining</div>'
      : state === 'NOT_STARTED' ? '<div class="wty-clock">Starts when your order is delivered</div>'
      : state === 'EXPIRED' ? '<div class="wty-clock is-done">Protection ended ' +
          esc(String(win.expiresAt || '').slice(0, 10)) + '</div>'
      : '';

    /* An expired window EXPLAINS itself rather than hiding the button — a control that
       vanishes reads as a platform that lost the feature. */
    var action =
      state === 'ACTIVE'
        ? '<button type="button" class="sk-btn sk-btn-primary wty-request" ' +
          'data-line="' + esc(l.line) + '">Request return / refund</button>'
      : state === 'EXPIRED'
        ? '<div class="wty-why">The ' + esc(l.durationDays) + '-day protection on this item ' +
          'has ended, so a return cannot be opened here. Contact the seller if something is wrong.</div>'
      : '<div class="wty-why">You can open a return once this order has been delivered.</div>';

    return '<article class="wty-line" data-line="' + esc(l.line) + '">' +
      '<div class="wty-line-h">' + esc(name) + '</div>' +
      '<div class="wty-days">Protected for ' + esc(l.durationDays) + ' day' +
        (l.durationDays === 1 ? '' : 's') + '</div>' +
      '<div class="wty-start">Protection starts when your order is delivered</div>' +
      clock +
      (remedies ? '<div class="wty-chips">' + remedies + '</div>' : '') +
      (reasons ? '<div class="wty-sub">Eligible reasons</div><div class="wty-chips">' + reasons + '</div>' : '') +
      action +
      '</article>';
  }

  /* ── 3. THE RETURN SHEET ────────────────────────────────────────────────── */

  var SHEET_STEPS = ['reason', 'remedy', 'evidence', 'review'];

  /**
   * The buyer's return request, as a bottom sheet.
   *
   * Only the options carried on the pinned line are rendered — an option shown and then
   * refused teaches a buyer the platform is unreliable, and one honoured that was never
   * offered teaches the seller the same.
   *
   * It COLLECTS and SUBMITS. It computes no amount, decides no fault and states no
   * liability: those come back from the server after submission, and are shown then.
   */
  function refundSheetHTML(state) {
    var s = state || {};
    var line = s.line || {};
    var step = s.step || 'reason';

    var body;
    if (step === 'reason') {
      body = '<div class="wty-q">What happened?</div>' +
        '<div class="wty-tiles">' + (line.reasons || []).map(function (r) {
          var k = r.key || r;
          return tile('sheetReason', k, s.reason === k, iconOf(REASONS, k),
                      r.label || labelOf(REASONS, k), '');
        }).join('') + '</div>';
    } else if (step === 'remedy') {
      body = '<div class="wty-q">What would you like us to do?</div>' +
        '<div class="wty-tiles">' + (line.remedies || []).map(function (k) {
          return tile('sheetRemedy', k, (s.remedies || []).indexOf(k) > -1,
                      iconOf(REMEDIES, k), labelOf(REMEDIES, k), '');
        }).join('') + '</div>';
    } else if (step === 'evidence') {
      body = '<div class="wty-q">Anything that helps us see it?</div>' +
        '<div class="wty-eviq">Photos and a short note make a return much quicker to settle. ' +
        'All of this is optional.</div>' +
        '<div class="wty-evi">' +
          '<label class="wty-evi-btn"><input type="file" accept="image/*" multiple hidden ' +
            'data-wty="photos">📷 Add photos</label>' +
          '<label class="wty-evi-btn"><input type="file" accept="video/*" hidden ' +
            'data-wty="video">🎥 Add video</label>' +
        '</div>' +
        '<div class="wty-evi-count">' + esc((s.media || []).length) + ' attached</div>' +
        '<textarea class="wty-note" data-wty="note" maxlength="2000" ' +
          'placeholder="Tell us more (optional)">' + esc(s.note || '') + '</textarea>';
    } else {
      body = '<div class="wty-q">Review your request</div>' +
        '<dl class="wty-review">' +
          '<dt>Item</dt><dd>' + esc(line.productName || 'This item') + '</dd>' +
          '<dt>What happened</dt><dd>' + esc(labelOf(REASONS, s.reason)) + '</dd>' +
          '<dt>You asked for</dt><dd>' + esc((s.remedies || []).map(function (k) {
            return labelOf(REMEDIES, k); }).join(', ')) + '</dd>' +
          ((s.media || []).length ? '<dt>Evidence</dt><dd>' + esc(s.media.length) + ' attached</dd>' : '') +
          (s.note ? '<dt>Details</dt><dd>' + esc(s.note) + '</dd>' : '') +
        '</dl>' +
        /* NO AMOUNT IS SHOWN OR SENT. What a refund is worth is the order's, decided by the
           server after this is submitted — printing a figure here would be this browser
           making a promise it has no authority to keep. */
        '<div class="wty-review-note">SOKONI will confirm what you are owed from your order ' +
        'once your request is reviewed.</div>';
    }

    var idx = SHEET_STEPS.indexOf(step);
    var canNext =
      step === 'reason' ? !!s.reason :
      step === 'remedy' ? !!(s.remedies && s.remedies.length) :
      true;

    return '' +
      '<div class="wty-sheet" role="dialog" aria-modal="true" aria-label="Return or refund">' +
        '<div class="wty-scrim" data-wty="close"></div>' +
        '<div class="wty-panelbox">' +
          '<div class="wty-grab" aria-hidden="true"></div>' +
          '<div class="wty-sh-h">↩️ Return or refund</div>' +
          /* Reassuring rather than adversarial: a buyer opening this has already had a bad
             experience, and a form that reads like a dispute makes it worse. */
          '<div class="wty-sh-sub">We\'re here to help make it right.</div>' +
          '<div class="wty-steps" aria-hidden="true">' + SHEET_STEPS.map(function (st, n) {
            return '<span class="wty-step' + (n <= idx ? ' is-done' : '') + '"></span>';
          }).join('') + '</div>' +
          (s.error ? '<div class="wty-err">' + esc(s.error) + '</div>' : '') +
          '<div class="wty-sh-body">' + body + '</div>' +
          '<div class="wty-sh-foot">' +
            (idx > 0 ? '<button type="button" class="wty-back" data-wty="back">Back</button>' : '') +
            (step === 'review'
              ? '<button type="button" class="sk-btn sk-btn-primary wty-next" data-wty="submit"' +
                (s.busy ? ' disabled' : '') + '>' + (s.busy ? 'Sending…' : 'Submit request') + '</button>'
              : '<button type="button" class="sk-btn sk-btn-primary wty-next" data-wty="next"' +
                (canNext ? '' : ' disabled') + '>Continue →</button>') +
          '</div>' +
        '</div>' +
      '</div>';
  }

  /**
   * What the server said, once the request is in.
   *
   * The state shown is the SERVER's — never "Refunded" because somebody pressed Submit.
   */
  function refundOutcomeHTML(res) {
    if (!res) return '';
    var st = String(res.state || 'REQUESTED').toUpperCase();
    var WORD = {
      REQUESTED: 'Refund requested',
      ELIGIBLE: 'Approved — being prepared',
      PROCESSING: 'Processing with your payment provider',
      PROVIDER_CONFIRMED: 'Confirmed by your payment provider',
      REFUNDED: 'Refunded',
      FAILED: 'Could not be completed — we are retrying',
      REFUSED: 'Not eligible',
    };
    /* SELLER FAULT IS THE SERVER'S ANSWER, rendered rather than derived. */
    var fault = res.returnDelivery && res.returnDelivery.payer === 'SELLER'
      ? '<div class="wty-fault">This return qualifies as <b>seller-fault return delivery</b>. ' +
        'You will not pay to send it back.</div>'
      : res.returnDelivery && res.returnDelivery.payer === 'BUYER'
      ? '<div class="wty-fault is-buyer">Return delivery for this request is the buyer\'s.</div>'
      : res.returnDelivery && res.returnDelivery.settled === 'requires_review'
      ? '<div class="wty-fault is-buyer">Who covers the return delivery will be confirmed on review.</div>'
      : '';

    return '<div class="wty-outcome" data-state="' + esc(st) + '">' +
      '<div class="wty-out-h">✓ ' + esc(WORD[st] || st) + '</div>' +
      fault +
      '<div class="wty-out-track">' + ['REQUESTED', 'PROCESSING', 'REFUNDED'].map(function (k) {
        var reached = (k === 'REQUESTED') ||
          (k === 'PROCESSING' && ['PROCESSING', 'PROVIDER_CONFIRMED', 'REFUNDED'].indexOf(st) > -1) ||
          (k === 'REFUNDED' && st === 'REFUNDED');
        return '<span class="wty-out-step' + (reached ? ' is-done' : '') + '">' +
          esc(WORD[k]) + '</span>';
      }).join('') + '</div>' +
      '</div>';
  }

  global.SokoniWarrantyUI = {
    DURATIONS: DURATIONS, REMEDIES: REMEDIES, REASONS: REASONS, SHEET_STEPS: SHEET_STEPS,
    policyBuilderHTML: policyBuilderHTML,
    previewHTML: previewHTML,
    readBuilder: readBuilder,
    mountPolicyBuilder: mountPolicyBuilder,
    warrantyPanelHTML: warrantyPanelHTML,
    refundSheetHTML: refundSheetHTML,
    refundOutcomeHTML: refundOutcomeHTML,
    _esc: esc,
  };
})(typeof window !== 'undefined' ? window : globalThis);
