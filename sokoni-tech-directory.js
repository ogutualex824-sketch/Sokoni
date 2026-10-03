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
      + (canBook ? '<button type="button" class="' + x + '-ico" data-tech-act="book" data-uid="' + esc(p.uid) + '" aria-label="Book ' + esc(p.name) + '" title="Book">📩</button>' : '')
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
        state(cfg, 'No approved ' + esc(cfg.noun) + 's are listed here yet.<br><a href="' + esc(cfg.applyUrl) + '" data-tech-act="apply" data-cat="' + esc(cfg.category || '') + '" style="color:#3b82f6;font-weight:700;">Are you a ' + esc(cfg.noun) + '? Apply to be listed →</a>');
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

  /* Built-in card styles for pages that do not carry the pg-* card CSS (prefix 'stdir'). Injected once. */
  function injectStyles() {
    if (document.getElementById('stdir-css') || !document.createElement) return;
    var st = document.createElement('style'); st.id = 'stdir-css';
    st.textContent = '.stdir-provider-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:8px}'
      + '.stdir-prov-top{display:flex;gap:10px;align-items:flex-start}.stdir-prov-avatar{width:44px;height:44px;border-radius:12px;background:rgba(0,212,255,0.1);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;overflow:hidden}'
      + '.stdir-prov-name{font-weight:800;font-size:14px}.stdir-verified-badge{font-size:9px;font-weight:800;color:#00d4ff;background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.25);padding:1px 6px;border-radius:5px}'
      + '.stdir-prov-loc,.stdir-prov-rnum{font-size:11px;color:rgba(255,255,255,0.5)}.stdir-prov-stars{color:#fbbf24;font-size:11px;margin-right:4px}.stdir-prov-bio{font-size:12px;color:rgba(255,255,255,0.65);line-height:1.5}'
      + '.stdir-prov-skills{display:flex;gap:5px;flex-wrap:wrap}.stdir-prov-skill{font-size:10px;padding:2px 7px;border-radius:5px;background:rgba(0,212,255,0.07);border:1px solid rgba(0,212,255,0.15)}'
      + '.stdir-prov-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto}.stdir-prov-rate{font-size:13px;font-weight:800}.stdir-prov-rate small{font-weight:500;color:rgba(255,255,255,0.45)}'
      + '.stdir-ico{min-width:44px;min-height:44px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.05);color:inherit;font-size:18px;cursor:pointer}.stdir-ico:focus-visible{outline:2px solid #00d4ff;outline-offset:2px}';
    (document.head || document.documentElement).appendChild(st);
  }

  /* ── One intake (Tech Hub slice 3) ──────────────────────────────────────────────────────────────────────────
     Registration is HubRegister.open — the ONE intake every "Register a business" entry uses (offer.html, f3 be46c94,
     owner 2026-10-01). It writes applications/{id}; AdminOS decides it (applicationDecide); nothing is listed before
     approval. Directory groups map to an EXISTING HubRegister CATS id; anything else opens the intake unselected
     rather than inventing a category. Without hub-register.js loaded, offer.html is the entry. */
  var INTAKE_CAT = {
    'phone-repair': 'phone-repair', electrical: 'electrical', 'it-support': 'it-support', networking: 'networking',
    'laptop-repair': 'laptop-repair', 'computer-repair': 'computer-repair', 'electronics-repair': 'electronics-repair',
    'pos-support': 'pos-support',
    cctv: 'cctv', software: 'software', 'web-developer': 'web-developer', 'app-developer': 'app-developer',
    plumbing: 'plumbing', cleaning: 'cleaning', laundry: 'laundry', moving: 'moving', gardening: 'landscaping',
    appliance: 'ac-repair', security: 'security-guard', painting: 'painting', carpentry: 'carpentry',
  };
  var TECH_IDS = ['phone-repair', 'laptop-repair', 'computer-repair', 'electronics-repair', 'it-support', 'networking', 'pos-support',
    'cctv', 'software', 'web-developer', 'app-developer'];
  function apply(category, hub) {
    var id = INTAKE_CAT[String(category || '').toLowerCase()] || '';
    var h = hub || (id ? (TECH_IDS.indexOf(id) > -1 ? 'tech' : 'home-services') : '');
    if (G.HubRegister && typeof G.HubRegister.open === 'function') {
      var o = {}; if (id) o.category = id; if (h) o.hub = h;
      G.HubRegister.open(o);
      return true;
    }
    G.location.href = 'offer.html';
    return false;
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('[data-tech-act="apply"]') : null;
      if (!a) return;
      if (e.preventDefault) e.preventDefault();
      apply(a.getAttribute('data-cat'), a.getAttribute('data-hub'));
    });
  }

  var byGrid = {};

  function mount(opts) {
    var cfg = Object.assign({ prefix: 'pg', noun: 'technician', applyUrl: 'offer.html' }, opts || {});
    if (cfg.prefix === 'stdir') injectStyles();
    if (byGrid[cfg.grid]) { Object.assign(byGrid[cfg.grid], opts || {}); return render(byGrid[cfg.grid]); }
    byGrid[cfg.grid] = cfg;
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
    /* Change a mounted grid's filters (e.g. a tab's category) and re-render, without a second mount. */
    update: function (grid, patch) { var c = byGrid[grid]; if (!c) return Promise.resolve(); Object.assign(c, patch || {}); return render(c); },
    apply: apply,
    _internal: { card: card, matches: matches, INTAKE_CAT: INTAKE_CAT },
  };
}(typeof window !== 'undefined' ? window : globalThis));
