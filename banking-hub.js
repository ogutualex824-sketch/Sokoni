/* ============================================================================
   SOKONI Banking Hub — partner directory + Foundation pane (client) — 2026-10-01

   Replaces sokoni-banking-pro.js on banking.html. That file rendered wallet,
   dashboard, BNPL, invoices, payment history, notifications and an "admin" panel
   out of localStorage — balances no server knew about. This file renders ONLY:

   - approved financial partners from financialPartnerDispatch publicDirectory,
     one pane per category, loaded lazily on first open (no request storm);
   - partner profile (publicProfile) and enquiry (submitEnquiry, signed-in, consent);
   - the 3 latest published Foundation stories (foundationContentDispatch,
     destination 'banking_hub').

   Wording rule: a listing is "Listed by SOKONI". It is never described as
   verified, licensed or regulator-approved — SOKONI reviewed paperwork; it did
   not confirm a licence. Registration details are shown as self-declared.
   A failed or undeployed callable is "not available right now", never "none".
   ============================================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var safeUrl = function (u) { return (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u)) ? u : ''; };
  var TYPE_LABELS = {
    BANK: 'Bank', SACCO: 'SACCO', ACCOUNTANT: 'Accountant', FINANCIAL_ADVISER: 'Financial adviser',
    INSURER: 'Insurer', MICROFINANCE: 'Microfinance', INVESTMENT: 'Investment firm', FOREX: 'Forex bureau',
    CHAMA: 'Chama', OTHER: 'Financial service', DIGITAL_LENDER: 'Digital lender',
    PAYMENT_PROVIDER: 'Payment provider', BUSINESS_FINANCE: 'Business finance'
  };
  var typeLabel = function (t) { return TYPE_LABELS[t] || 'Financial service'; };
  var label = function (k) { return String(k || '').replace(/_/g, ' ').toLowerCase().replace(/^./, function (c) { return c.toUpperCase(); }); };

  function call(name, data) {
    return window.waitForFirebaseReady().then(function () {
      return window.sokoniCallable(name)(data || {});
    }).then(function (r) { return r && r.data; });
  }
  function code(e) { return String((e && e.code) || '').replace(/^functions\//, ''); }
  function ready() {
    return new Promise(function (resolve, reject) {
      var n = 0;
      (function wait() {
        if (typeof window.waitForFirebaseReady === 'function' && typeof window.sokoniCallable === 'function') return resolve();
        if (++n > 30) return reject(new Error('firebase-unavailable'));
        setTimeout(wait, 400);
      }());
    });
  }
  function currentUser() { return (window.firebaseAuth && window.firebaseAuth.currentUser) || null; }

  /* ── Directory panes ──────────────────────────────────────────────────────────────── */
  var S = {};   /* paneName -> { loaded, loading, next, partners: {uid: row} } */

  function card(r) {
    var uid = String(r.partnerUid || '');
    var services = Array.isArray(r.services) ? r.services.slice(0, 6) : [];
    var site = safeUrl(r.website);
    return '<article class="bkd-card">' +
      '<div class="bkd-tags"><span class="bkd-listed">Listed by SOKONI</span>' +
        (r.promoted === true ? '<span class="bkd-promo">Promoted</span>' : '') + '</div>' +
      '<h3>' + esc(r.name || 'Unnamed institution') + '</h3>' +
      '<div class="bkd-type">' + esc(typeLabel(r.institutionType)) + (r.county ? ' · ' + esc(r.county) : '') + '</div>' +
      (r.institutionType === 'DIGITAL_LENDER' ? '<p class="bkd-warn">Check the lender\'s CBK licence before borrowing.</p>' : '') +
      (services.length ? '<div class="bkd-tags">' + services.map(function (s) { return '<span class="bkd-tag">' + esc(label(s)) + '</span>'; }).join('') + '</div>' : '') +
      (site ? '<div class="bkd-meta"><a href="' + esc(site) + '" target="_blank" rel="noopener noreferrer">' + esc(site.replace(/^https:\/\//i, '').replace(/\/$/, '')) + '</a></div>' : '') +
      '<div class="bkd-actions">' +
        '<button type="button" class="bkd-btn bkd-btn-acc" data-contact="' + esc(uid) + '">Contact</button>' +
        '<button type="button" class="bkd-btn" data-profile="' + esc(uid) + '">View profile</button>' +
      '</div></article>';
  }
  function emptyHtml(pane) {
    var cat = pane.getAttribute('data-label') || 'institution';
    var type = pane.getAttribute('data-apply') || 'OTHER';
    var plural = pane.getAttribute('data-plural') || (cat + 's');
    var article = /^[aeiou]/i.test(cat) ? 'an' : 'a';
    return '<div class="bk-pending"><div class="bk-pending-t">No ' + esc(plural) + ' listed yet</div>' +
      '<p class="bk-pending-p">Are you ' + article + ' ' + esc(cat) + '? Apply to be listed on SOKONI.</p>' +
      '<a class="bkd-btn bkd-btn-acc" data-apply-link href="business-apply.html?offer=financial&amp;category=' + encodeURIComponent(type) + '">Apply to be listed</a></div>';
  }
  function paneSkeleton(pane) {
    pane.innerHTML = '<p class="bkd-intro">' + esc(pane.getAttribute('data-intro') || '') + '</p>' +
      '<div class="bkd-status" role="status" aria-live="polite">Loading listings…</div>' +
      '<div class="bkd-grid"></div><div class="bkd-more"><button type="button" class="bkd-btn" data-more hidden>Load more</button></div>';
  }
  function loadPane(name, more) {
    var pane = $('pane-' + name);
    if (!pane || !pane.hasAttribute('data-types')) return;
    var st = S[name] || (S[name] = { loaded: false, loading: false, next: null, partners: {} });
    if (st.loading || (st.loaded && !more)) return;
    st.loading = true;
    if (!more) paneSkeleton(pane);
    var status = pane.querySelector('.bkd-status'), grid = pane.querySelector('.bkd-grid'), btn = pane.querySelector('[data-more]');
    if (more) { btn.disabled = true; status.textContent = 'Loading more…'; }
    var q = { op: 'publicDirectory', types: pane.getAttribute('data-types').split(',') };
    if (more && st.next) q.cursor = st.next;
    ready().then(function () { return call('financialPartnerDispatch', q); }).then(function (r) {
      var rows = (r && Array.isArray(r.rows)) ? r.rows : [];
      st.loaded = true; st.next = (r && r.next) || null;
      rows.forEach(function (row) { if (row && row.partnerUid) st.partners[row.partnerUid] = row; });
      if (!more && !rows.length) { status.textContent = ''; grid.outerHTML = emptyHtml(pane); btn.hidden = true; return; }
      grid.insertAdjacentHTML('beforeend', rows.map(card).join(''));
      status.textContent = more ? rows.length + ' more listed.' : '';
      btn.hidden = !st.next; btn.disabled = false;
    }).catch(function () {
      status.textContent = "The directory isn't available right now. Please try again later.";
      if (btn) { btn.disabled = false; btn.hidden = !st.next; }
      if (!more) { st.loaded = false; status.insertAdjacentHTML('beforeend', ' <button type="button" class="bkd-btn" data-retry>Try again</button>'); }
    }).then(function () { st.loading = false; });
  }

  /* ── Foundation pane ──────────────────────────────────────────────────────────────── */
  var foundationLoaded = false;
  function storyCard(r) {
    var m = (Array.isArray(r.media) ? r.media : [])[0], media = '';
    if (m && m.type === 'image' && safeUrl(m.thumbUrl || m.url)) media = '<img loading="lazy" decoding="async" src="' + esc(safeUrl(m.thumbUrl || m.url)) + '" alt="' + esc('Photo shared with the story: ' + (r.title || 'Story')) + '">';
    else if (m && m.type === 'video' && safeUrl(m.url)) media = '<video controls playsinline preload="none"' + (safeUrl(m.thumbUrl) ? ' poster="' + esc(safeUrl(m.thumbUrl)) + '"' : '') + ' src="' + esc(safeUrl(m.url)) + '" aria-label="' + esc('Video: ' + (r.title || 'Story')) + '"></video>';
    var who = [r.name, r.location].filter(Boolean).join(' · ');
    return '<article class="bkd-card bkd-story">' + media +
      '<h3>' + esc(r.title || 'Untitled') + '</h3>' +
      (who ? '<div class="bkd-type">' + esc(who) + '</div>' : '') +
      '<p class="bkd-meta">' + esc(r.excerpt || '') + '</p>' +
      '<div class="bkd-actions"><a class="bkd-btn" href="foundation.html#stories">Read on the Foundation page</a>' +
        (r.programmeId ? '<a class="bkd-btn bkd-btn-acc" href="foundation.html?programme=' + encodeURIComponent(r.programmeId) + '#donate">Support this work</a>' : '') +
      '</div></article>';
  }
  function loadFoundation() {
    if (foundationLoaded) return;
    foundationLoaded = true;
    var st = $('bkdFoundationStatus'), grid = $('bkdFoundationStories');
    st.textContent = 'Loading stories…';
    ready().then(function () {
      return call('foundationContentDispatch', { op: 'listPublished', destination: 'banking_hub', limit: 3 });
    }).then(function (r) {
      var rows = (r && Array.isArray(r.rows)) ? r.rows.slice(0, 3) : [];
      st.textContent = rows.length ? '' : 'No stories published here yet. Has the Foundation helped you? Share your story.';
      grid.innerHTML = rows.map(storyCard).join('');
    }).catch(function () {
      foundationLoaded = false;
      st.textContent = "Stories aren't available right now.";
    });
  }

  /* ── Modals ───────────────────────────────────────────────────────────────────────── */
  var lastFocus = null;
  function openModal(title, html) {
    closeModal();
    lastFocus = document.activeElement;
    var m = document.createElement('div');
    m.className = 'bkd-modal'; m.id = 'bkdModal';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'bkdModalTitle');
    m.innerHTML = '<div class="bkd-sheet"><h2 id="bkdModalTitle">' + esc(title) + '</h2><div id="bkdModalBody">' + html + '</div>' +
      '<div class="bkd-sheet-actions"><button type="button" class="bkd-btn" data-close>Close</button></div></div>';
    document.body.appendChild(m);
    var f = m.querySelector('input, textarea, button'); if (f) f.focus();
    return m;
  }
  function closeModal() {
    var m = $('bkdModal'); if (!m) return;
    m.remove();
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (_) {} }
  }
  document.addEventListener('keydown', function (ev) {
    var m = $('bkdModal'); if (!m) return;
    if (ev.key === 'Escape') { closeModal(); return; }
    if (ev.key === 'Tab') {   /* keep focus inside the dialog */
      var f = m.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea, select');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  });

  function findPartner(uid) {
    for (var k in S) { if (S[k].partners[uid]) return S[k].partners[uid]; }
    return null;
  }
  function list(items, fmt) {
    if (!Array.isArray(items) || !items.length) return '';
    return '<ul>' + items.slice(0, 30).map(function (x) { return '<li>' + esc(fmt ? fmt(x) : x) + '</li>'; }).join('') + '</ul>';
  }
  function branchText(b) { return typeof b === 'string' ? b : [b && b.name, b && (b.town || b.county), b && b.address].filter(Boolean).join(' · '); }
  function productText(p) {
    if (typeof p === 'string') return p;
    var bits = [p && p.name, p && p.kind ? label(p.kind) : '', p && p.rate != null && p.rate !== '' ? 'Rate: ' + p.rate : '', p && p.description];
    return bits.filter(Boolean).join(' — ');
  }
  function hoursText(h) {
    if (!h) return '';
    if (typeof h === 'string') return h;
    return Object.keys(h).slice(0, 7).map(function (d) { return label(d) + ': ' + h[d]; }).join(' · ');
  }
  function showProfile(uid) {
    var base = findPartner(uid) || {};
    openModal(base.name || 'Profile', '<p class="bkd-status" role="status" aria-live="polite">Loading profile…</p>');
    ready().then(function () { return call('financialPartnerDispatch', { op: 'publicProfile', partnerUid: uid }); }).then(function (r) {
      var p = (r && (r.profile || r.listing)) || r || {};
      var products = (r && Array.isArray(r.products)) ? r.products : (Array.isArray(p.products) ? p.products : []);
      var site = safeUrl(p.website || base.website);
      var reg = p.licenceClaimed || p.registrationNumber || p.registration || base.licenceClaimed;
      var itype = p.institutionType || base.institutionType;
      var county = p.county || base.county;
      var promoted = (p.promoted === true || base.promoted === true);
      var services = Array.isArray(p.services) ? p.services : [];
      var branches = Array.isArray(p.branches) ? p.branches : [];
      var hours = hoursText(p.hours);
      var body =
        '<div class="bkd-tags"><span class="bkd-listed">Listed by SOKONI</span>' + (promoted ? '<span class="bkd-promo">Promoted</span>' : '') + '</div>' +
        '<p class="bkd-type">' + esc(typeLabel(itype)) + (county ? ' · ' + esc(county) : '') + '</p>' +
        (itype === 'DIGITAL_LENDER' ? '<p class="bkd-warn">Check the lender\'s CBK licence before borrowing.</p>' : '') +
        (p.description ? '<h3>About</h3><p>' + esc(p.description) + '</p>' : '') +
        (services.length ? '<h3>Services</h3>' + list(services, label) : '') +
        (branches.length ? '<h3>Branches</h3>' + list(branches, branchText) : '') +
        (hours ? '<h3>Hours</h3><p>' + esc(hours) + '</p>' : '') +
        (products.length ? '<h3>Products and rates</h3>' + list(products, productText) + '<p class="bkd-meta">Published by the institution. Confirm terms with them before you commit.</p>' : '') +
        (reg ? '<h3>Registration</h3><p>' + esc(reg) + ' <span class="bkd-meta">(self-declared — not checked by SOKONI)</span></p>' : '') +
        (site ? '<h3>Website</h3><p><a href="' + esc(site) + '" target="_blank" rel="noopener noreferrer">' + esc(site) + '</a></p>' : '') +
        '<div class="bkd-sheet-actions"><button type="button" class="bkd-btn bkd-btn-acc" data-contact="' + esc(uid) + '">Contact</button></div>';
      var b = $('bkdModalBody'); if (b) b.innerHTML = body;
    }).catch(function (e) {
      var b = $('bkdModalBody');
      if (b) b.innerHTML = '<p>' + esc(code(e) === 'not-found' ? "This profile isn't available right now." : "Profiles aren't available right now. Please try again later.") + '</p>';
    });
  }

  function showContact(uid) {
    var base = findPartner(uid) || {};
    var u = currentUser();
    var title = 'Contact ' + (base.name || 'institution');   /* openModal() escapes the title */
    if (!u) {
      var back = 'banking.html' + (location.hash || '');
      openModal(title,
        '<p>Please sign in to contact a listed institution — it lets them reply to you and keeps your details out of public view.</p>' +
        '<p><a class="bkd-btn bkd-btn-acc" href="login.html?redirect=' + encodeURIComponent(back) + '">Sign in</a></p>');
      return;
    }
    var m = openModal(title,
      '<form id="bkdEnquiry" novalidate>' +
        '<div class="bkd-field"><label for="bkdEqName">Your name</label><input id="bkdEqName" name="name" maxlength="80" autocomplete="name" required></div>' +
        '<div class="bkd-field"><label for="bkdEqPhone">Phone number</label><input id="bkdEqPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="16" required></div>' +
        '<div class="bkd-field"><label for="bkdEqTopic">What is it about?</label><input id="bkdEqTopic" name="topic" maxlength="80" required placeholder="e.g. Business loan, opening an account"></div>' +
        '<div class="bkd-field"><label for="bkdEqMsg">Message</label><textarea id="bkdEqMsg" name="message" maxlength="2000" required></textarea></div>' +
        '<label class="bkd-check"><input type="checkbox" id="bkdEqConsent" name="consent" required><span>I agree that SOKONI shares my name, phone number and message with this institution so they can reply to me.</span></label>' +
        '<p class="bkd-err" id="bkdEqErr" role="alert"></p>' +
        '<div class="bkd-status" id="bkdEqStatus" role="status" aria-live="polite"></div>' +
        '<div class="bkd-sheet-actions"><button type="submit" class="bkd-btn bkd-btn-acc" id="bkdEqSend">Send enquiry</button></div>' +
      '</form>');
    $('bkdEqName').value = u.displayName || '';
    if (u.phoneNumber) $('bkdEqPhone').value = '0' + String(u.phoneNumber).replace(/^\+?254/, '');
    $('bkdEnquiry').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var d = { name: $('bkdEqName').value.trim(), phone: $('bkdEqPhone').value.replace(/[^\d+]/g, ''), topic: $('bkdEqTopic').value.trim(), message: $('bkdEqMsg').value.trim() };
      var err = !d.name ? 'Enter your name.' : !/^(\+?254|0)[17]\d{8}$/.test(d.phone) ? 'Enter a valid Kenyan phone number.' :
        !d.topic ? 'Say what it is about.' : d.message.length < 10 ? 'Write a short message (at least 10 characters).' :
        !$('bkdEqConsent').checked ? 'Please tick the consent box so we can pass your details on.' : '';
      $('bkdEqErr').textContent = err;
      if (err) return;
      var btn = $('bkdEqSend'); btn.disabled = true;
      $('bkdEqStatus').textContent = 'Sending…';
      call('financialPartnerDispatch', { op: 'submitEnquiry', partnerUid: uid, name: d.name, phone: d.phone, topic: d.topic, message: d.message, consent: true }).then(function (r) {
        if (!r || r.ok === false) throw { code: 'internal' };
        var body = $('bkdModalBody');
        if (body) body.innerHTML = '<p class="bkd-ok">Your enquiry was sent.</p><p>The institution will contact you directly. SOKONI does not arrange loans or accounts on their behalf.</p>';
      }).catch(function (e) {
        var c = code(e);
        btn.disabled = false; $('bkdEqStatus').textContent = '';
        $('bkdEqErr').textContent = c === 'unauthenticated' ? 'Please sign in again.' :
          c === 'resource-exhausted' ? 'You have sent several enquiries recently. Please try again later.' :
          c === 'invalid-argument' ? 'Please check your details and try again.' :
          "Enquiries aren't available right now. Please try again later.";
      });
    });
    return m;
  }

  /* ── Wiring ───────────────────────────────────────────────────────────────────────── */
  document.addEventListener('bk:pane', function (ev) {
    var name = ev.detail && ev.detail.name;
    if (name === 'foundation') loadFoundation(); else loadPane(name, false);
  });
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t.closest) return;
    var m = $('bkdModal');
    if (m && (t === m || t.closest('[data-close]'))) { closeModal(); return; }
    var c = t.closest('[data-contact]'); if (c) { showContact(c.getAttribute('data-contact')); return; }
    var p = t.closest('[data-profile]'); if (p) { showProfile(p.getAttribute('data-profile')); return; }
    var pane = t.closest('.bk-pane');
    if (pane && t.closest('[data-more]')) { loadPane(pane.id.replace('pane-', ''), true); return; }
    if (pane && t.closest('[data-retry]')) { loadPane(pane.id.replace('pane-', ''), false); }
  });

  function fromHash() {
    var h = (location.hash || '').slice(1).replace(/[^\w-]/g, '');
    return h && $('pane-' + h) ? h : '';
  }
  function init() {
    var h = fromHash();
    if (typeof window.showTab === 'function') window.showTab(h || 'loans', null, { noScroll: !h });
  }
  window.addEventListener('hashchange', function () { var h = fromHash(); if (h && typeof window.showTab === 'function') window.showTab(h, null); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
