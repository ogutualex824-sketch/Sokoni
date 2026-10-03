/* ═══════════════════════════════════════════════════════════════════════════
   SokoniTechDirectory — Tech Hub provider listings on the canonical service engine (2026-10-03)
   ═══════════════════════════════════════════════════════════════════════════
   Tech Hub pages (phone repair, electrical, and the Tech Hub repair / IT tabs) used hardcoded provider arrays with
   invented ratings, job counts and "verified" badges, and booked over WhatsApp or into localStorage. This module
   renders the REAL registry instead and acts only through existing authorities:

     list      SokoniProviders.list({ category })   providers/{uid}, status active|approved (approval-gated)
     book      SokoniBookService.open({ providerId }) → bookingCreateService (server price + slot lock)
                                                      → createPaymentIntent(service_booking) → IntaSend → webhook
     message   SokoniInbox.openChat({ otherUid })    in-app conversations (no WhatsApp)
     profile   provider-profile.html?uid=…            the provider's storefront

   It writes nothing. Ratings and job counts render only when the provider record carries real ones. Loading,
   error and empty are distinct states: an unreachable registry is never shown as "no technicians".

     SokoniTechDirectory.mount({
       grid: 'pgProviderGrid', count: 'pgProvCount', category: 'phone-repair',
       prefix: 'pg', search: () => '', type: () => '', location: () => '',
       noun: 'technician',
     });
   ═══════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var mounts = [];

  function state(cfg, html) {
    var grid = document.getElementById(cfg.grid);
    if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:36px 20px;color:rgba(255,255,255,0.4);font-size:13px;line-height:1.6;">' + html + '</div>';
  }

  function card(p, cfg) {
    var x = cfg.prefix;
    var stars = p.rating != null
      ? '<span class="' + x + '-prov-stars">' + '★'.repeat(Math.round(p.rating)) + '☆'.repeat(5 - Math.round(p.rating)) + '</span>'
        + '<span class="' + x + '-prov-rnum">' + esc(p.rating.toFixed(1)) + (p.reviewCount ? ' · ' + esc(p.reviewCount) + ' reviews' : '') + '</span>'
      : '<span class="' + x + '-prov-rnum">New on SOKONI</span>';
    var jobs = p.jobsCompleted > 0 ? '<span class="' + x + '-prov-rnum"> · ' + esc(p.jobsCompleted) + ' jobs</span>' : '';
    var skills = (p.skills || []).slice(0, 6).map(function (s) { return '<span class="' + x + '-prov-skill">' + esc(s) + '</span>'; }).join('');
    var rate = p.rate != null && p.rate > 0
      ? 'From KES ' + esc(Number(p.rate).toLocaleString()) + (p.rateType ? ' <small>' + esc(p.rateType) + '</small>' : '')
      : '<small>Price shown when you book</small>';
    var canBook = p.acceptsBookings !== false;
    return '<div class="' + x + '-provider-card" data-uid="' + esc(p.uid) + '">'
      + '<div class="' + x + '-prov-top"><div class="' + x + '-prov-avatar">' + (p.photo ? '<img src="' + esc(p.photo) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;" loading="lazy">' : esc(p.emoji || '🔧')) + '</div>'
      + '<div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px;">'
      + '<a class="' + x + '-prov-name" href="' + esc(p.profileUrl) + '" style="color:inherit;text-decoration:none;">' + esc(p.name) + '</a>'
      + (p.verified ? '<span class="' + x + '-verified-badge">✓ Verified</span>' : '') + '</div>'
      + '<div class="' + x + '-prov-loc">' + esc(p.categoryLabel) + (p.location ? ' · ' + esc(p.location) : '') + '</div>'
      + '<div class="' + x + '-prov-rating">' + stars + jobs + '</div></div></div>'
      + (p.description ? '<div class="' + x + '-prov-bio">' + esc(p.description.slice(0, 180)) + '</div>' : '')
      + (skills ? '<div class="' + x + '-prov-skills">' + skills + '</div>' : '')
      + '<div class="' + x + '-prov-foot"><div class="' + x + '-prov-rate">' + rate + '</div>'
      + '<div style="display:flex;gap:6px;align-items:center;">'
      + (p.chatEnabled !== false ? '<button type="button" class="' + x + '-ico" data-tech-act="chat" data-uid="' + esc(p.uid) + '" aria-label="Message ' + esc(p.name) + '" title="Message">💬</button>' : '')
      + (canBook ? '<button type="button" class="' + x + '-ico" data-tech-act="book" data-uid="' + esc(p.uid) + '" aria-label="Book ' + esc(p.name) + '" title="Book">📅</button>' : '')
      + '</div></div></div>';
  }

  function matches(p, cfg) {
    var q = String((cfg.search && cfg.search()) || '').toLowerCase().trim();
    var type = String((cfg.type && cfg.type()) || '').toLowerCase().trim();
    var loc = String((cfg.location && cfg.location()) || '').toLowerCase().trim();
    var hay = [p.name, p.businessName, p.categoryLabel, p.category, (p.categories || []).join(' '), p.description, (p.skills || []).join(' ')].join(' ').toLowerCase();
    if (q && hay.indexOf(q) < 0) return false;
    if (type && hay.indexOf(type) < 0) return false;
    if (loc && String(p.location + ' ' + p.city).toLowerCase().indexOf(loc) < 0) return false;
    return true;
  }

  function render(cfg) {
    if (!G.SokoniProviders || typeof G.SokoniProviders.list !== 'function') {
      state(cfg, 'Technician listings could not load. Please refresh.');
      return Promise.resolve();
    }
    state(cfg, 'Loading ' + esc(cfg.noun) + 's…');
    return G.SokoniProviders.list({ category: cfg.category }).then(function (r) {
      var all = r.providers || [];
      var cnt = document.getElementById(cfg.count);
      if (r.error && !all.length) {
        if (cnt) cnt.textContent = '';
        state(cfg, 'We couldn’t reach the ' + esc(cfg.noun) + ' directory just now. This is not an empty list — please try again shortly.');
        return;
      }
      var list = all.filter(function (p) { return matches(p, cfg); });
      if (cnt) cnt.textContent = list.length + ' ' + cfg.noun + (list.length === 1 ? '' : 's') + (r.stale ? ' (saved copy)' : '');
      if (!all.length) {
        state(cfg, 'No approved ' + esc(cfg.noun) + 's are listed here yet.<br><a href="' + esc(cfg.applyUrl) + '" style="color:#3b82f6;font-weight:700;">Are you a ' + esc(cfg.noun) + '? Apply to be listed →</a>');
        return;
      }
      if (!list.length) { state(cfg, 'No ' + esc(cfg.noun) + 's match these filters.'); return; }
      var grid = document.getElementById(cfg.grid);
      if (grid) grid.innerHTML = list.map(function (p) { return card(p, cfg); }).join('');
      cfg._byUid = {}; list.forEach(function (p) { cfg._byUid[p.uid] = p; });
    }).catch(function () {
      state(cfg, 'We couldn’t reach the ' + esc(cfg.noun) + ' directory just now. Please try again shortly.');
    });
  }

  function act(cfg, kind, uid) {
    var p = (cfg._byUid || {})[uid];
    if (!p) return;
    if (kind === 'book') {
      if (G.SokoniBookService && typeof G.SokoniBookService.open === 'function') {
        G.SokoniBookService.open({ providerId: p.uid, providerName: p.name });
      } else {
        location.href = p.profileUrl;   /* the storefront carries the same booking flow */
      }
    } else if (kind === 'chat') {
      if (G.SokoniInbox && typeof G.SokoniInbox.openChat === 'function') {
        G.SokoniInbox.openChat({ otherUid: p.uid, otherName: p.name, type: 'customer-provider', context: p.categoryLabel + ' · SOKONI Tech' });
      } else {
        location.href = 'messages.html';
      }
    }
  }

  /* firebase.js is a module and SokoniProviders reads window.firebaseDB, so neither is guaranteed at parse time.
     Wait for both (the same wait providers.html uses) rather than report a false outage. Gives up after 10 s,
     and then the list call reports the real error. */
  function ready() {
    return new Promise(function (res) {
      var t0 = Date.now();
      (function poll() {
        if ((G.SokoniProviders && G.firebaseDB) || Date.now() - t0 > 10000) return res();
        setTimeout(poll, 150);
      }());
    });
  }

  function mount(opts) {
    var cfg = Object.assign({ prefix: 'pg', noun: 'technician', applyUrl: 'business-apply.html?offer=services' }, opts || {});
    mounts.push(cfg);
    var grid = document.getElementById(cfg.grid);
    if (grid && !grid.__techBound) {
      grid.__techBound = true;
      grid.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-tech-act]') : null;
        if (b) act(cfg, b.getAttribute('data-tech-act'), b.getAttribute('data-uid'));
      });
    }
    state(cfg, 'Loading ' + esc(cfg.noun) + 's…');
    return ready().then(function () { return render(cfg); });
  }

  G.SokoniTechDirectory = {
    mount: mount,
    refresh: function () { return Promise.all(mounts.map(render)); },
    _internal: { card: card, matches: matches },
  };
}(typeof window !== 'undefined' ? window : globalThis));
