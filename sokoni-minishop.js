'use strict';
window.SokoniMiniShop = (() => {
  // ─── State ───────────────────────────────────────────────────────────────────
  let _state = {
    shopId: null, handle: null, config: {}, shop: {},
    currentUser: null, following: false, followerCount: 0,
    shopUrl: '', adminMode: false, products: [], services: []
  };
  const CF = 'https://us-central1-sokoni-aeb26.cloudfunctions.net';

  // ─── DOM Helpers ─────────────────────────────────────────────────────────────
  function _setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  function _setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }
  function _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }
  function _today() {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }
  function _stars(r, max) {
    max = max || 5;
    const full = Math.round(r || 0);
    let s = '';
    for (let i = 1; i <= max; i++) s += i <= full ? '★' : '☆';
    return s;
  }
  function _qrUrl(url) {
    return 'https://chart.googleapis.com/chart?chs=300x300&cht=qr&chl=' + encodeURIComponent(url) + '&choe=UTF-8';
  }

  // ─── Toast ───────────────────────────────────────────────────────────────────
  function _toast(msg, type) {
    type = type || 'info';
    const toastId = _state.adminMode ? 'msaToasts' : 'msToasts';
    let container = document.getElementById(toastId);
    if (!container) {
      container = document.createElement('div');
      container.id = toastId;
      container.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
      document.body.appendChild(container);
    }
    const t = document.createElement('div');
    const colors = { success: '#00c853', error: '#d32f2f', warning: '#f57c00', info: '#1565c0' };
    t.style.cssText = `background:${colors[type] || colors.info};color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.25);max-width:320px;text-align:center;opacity:0;transition:opacity .2s;`;
    t.textContent = msg;
    container.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 3200);
  }

  // ─── Handle Parser ───────────────────────────────────────────────────────────
  function _parseHandle() {
    // OG CF shell page pre-injects window.MS_HANDLE — use it first
    if (window.MS_HANDLE && /^[a-z0-9_-]{1,30}$/.test(window.MS_HANDLE)) {
      return window.MS_HANDLE;
    }
    const path = location.pathname;
    let m = path.match(/\/shop\/([^/?#]+)/);
    if (m) return m[1].replace(/^@/, '');
    m = path.match(/\/@([^/?#]+)/);
    if (m) return m[1];
    const params = new URLSearchParams(location.search);
    return params.get('handle') || '';
  }

  // ─── CF Caller ───────────────────────────────────────────────────────────────
  async function _callCF(name, data) {
    if (typeof firebase === 'undefined' || !firebase.functions) throw new Error('Firebase not loaded');
    const fn = firebase.functions().httpsCallable(name);
    const result = await fn(data || {});
    return result.data;
  }

  // ─── Source Detection ────────────────────────────────────────────────────────
  function _detectSource() {
    const params = new URLSearchParams(location.search);
    if (params.get('utm_source')) return params.get('utm_source');
    const ref = document.referrer;
    if (!ref) return 'direct';
    if (ref.includes('whatsapp')) return 'whatsapp';
    if (ref.includes('facebook') || ref.includes('fb.com')) return 'facebook';
    if (ref.includes('instagram')) return 'instagram';
    if (ref.includes('twitter') || ref.includes('x.com')) return 'x';
    if (ref.includes('t.me') || ref.includes('telegram')) return 'telegram';
    if (ref.includes('linkedin')) return 'linkedin';
    if (ref.includes('tiktok')) return 'tiktok';
    return 'other';
  }

  // ─── View Tracker ────────────────────────────────────────────────────────────
  async function _trackView(shopId) {
    try {
      const source = _detectSource();
      await fetch(CF + '/trackMinishopView?shopId=' + encodeURIComponent(shopId) + '&source=' + encodeURIComponent(source), { method: 'POST', mode: 'no-cors' });
    } catch (_) { /* silent */ }
  }

  // ─── Follow Status ───────────────────────────────────────────────────────────
  async function _checkFollowStatus() {
    try {
      if (typeof firebase === 'undefined') return;
      const user = firebase.auth().currentUser;
      if (!user || !_state.shopId) return;
      _state.currentUser = user;
      const snap = await firebase.firestore()
        .doc(`shopFollowers/${_state.shopId}/followers/${user.uid}`)
        .get();
      _state.following = snap.exists;
      _updateFollowBtn();
    } catch (_) { /* silent */ }
  }
  function _updateFollowBtn() {
    const btn = document.getElementById('msFollowBtn');
    if (!btn) return;
    btn.textContent = _state.following ? '✓ Following' : '+ Follow';
    btn.classList.toggle('ms-following', _state.following);
  }

  // ─── Trust Signals ───────────────────────────────────────────────────────────
  function _renderTrustSignals(shop, config) {
    const pills = [];
    if (shop.verified) pills.push({ cls: 'ms-trust-verified', text: '✓ Verified Business' });
    if (shop.responseRate >= 80) pills.push({ cls: 'ms-trust-response', text: shop.responseRate + '% Response Rate' });
    if (shop.rating >= 4) pills.push({ cls: 'ms-trust-rating', text: shop.rating + '★ Rated' });
    pills.push({ cls: 'ms-trust-payment', text: '🔒 Secure Payments' });
    return pills.map(p => '<span class="ms-trust-pill ' + p.cls + '">' + _esc(p.text) + '</span>').join('');
  }

  // ─── Smart CTA ───────────────────────────────────────────────────────────────
  function _getSmartCta(category) {
    const map = {
      'restaurant': [{ label: '🍽 View Menu', action: 'menu' }, { label: '📦 Order Now', action: 'order' }],
      'food': [{ label: '📦 Order Now', action: 'order' }, { label: '💬 Chat', action: 'chat' }],
      'hotel': [{ label: '🛎 Book Room', action: 'book' }, { label: '📞 Call', action: 'call' }],
      'property': [{ label: '🏠 View Listings', action: 'store' }, { label: '📞 Call Agent', action: 'call' }],
      'vehicle': [{ label: '🚗 View Cars', action: 'store' }, { label: '📞 Call Dealer', action: 'call' }],
      'healthcare': [{ label: '📅 Book Appointment', action: 'book' }, { label: '📞 Call', action: 'call' }],
      'legal': [{ label: '📅 Consultation', action: 'book' }, { label: '📞 Call', action: 'call' }],
      'events': [{ label: '🎟 Book Tickets', action: 'book' }, { label: '💬 Chat', action: 'chat' }],
      'salon': [{ label: '📅 Book Appointment', action: 'book' }, { label: '💬 Chat', action: 'chat' }],
      'education': [{ label: '📚 Enroll Now', action: 'book' }, { label: '💬 Chat', action: 'chat' }],
      'freelancer': [{ label: '💼 Hire Me', action: 'chat' }, { label: '📋 Get Quote', action: 'chat' }],
      'default': [{ label: '🛒 Shop Now', action: 'store' }, { label: '💬 Chat', action: 'chat' }]
    };
    const cat = (category || '').toLowerCase();
    for (const [key, ctAs] of Object.entries(map)) {
      if (key !== 'default' && cat.includes(key)) return ctAs;
    }
    return map.default;
  }
  function _ctaAction(action) {
    const sid = _state.shopId;
    const h = _state.handle;
    switch (action) {
      case 'store':
        const storeTab = document.getElementById('msTabStore');
        if (storeTab) storeTab.click();
        else { const el = document.getElementById('msProductsSection'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }
        break;
      case 'order': location.href = 'checkout.html?shopId=' + sid; break;
      case 'book': location.href = 'venue-booking.html?shopId=' + sid; break;
      case 'chat': location.href = 'messages.html?shopId=' + sid; break;
      case 'call': location.href = 'tel:' + (_state.config.contactPhone || ''); break;
      case 'menu':
        const menuTab = document.getElementById('msTabStore');
        if (menuTab) menuTab.click();
        break;
      default: break;
    }
  }

  // ─── Product Card ────────────────────────────────────────────────────────────
  function _productCard(p) {
    const price = Number(p.price || 0);
    const orig = Number(p.originalPrice || 0);
    const discount = p.discountPercent ? parseInt(p.discountPercent) : (orig > price && orig > 0 ? Math.round((orig - price) / orig * 100) : 0);
    const badge = p.isBestseller ? '<span class="ms-badge ms-badge-popular">Bestseller</span>' : (discount > 0 ? '<span class="ms-badge ms-badge-sale">-' + discount + '%</span>' : '');
    const imgUrl = _esc(p.imageUrl || p.images?.[0] || 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'200\' height=\'200\'%3E%3Crect fill=\'%23111\' width=\'200\' height=\'200\'/%3E%3C/svg%3E');
    return `<div class="ms-product-card" onclick="location.href='product.html?id=${_esc(p.id)}'">
  <img src="${imgUrl}" alt="${_esc(p.name)}" class="ms-product-img" loading="lazy">
  ${badge}
  <button class="ms-wishlist-btn" onclick="event.stopPropagation();SokoniMiniShop.toggleWishlist('${_esc(p.id)}')" aria-label="Wishlist">&#x2665;</button>
  <div class="ms-product-body">
    <div class="ms-product-name">${_esc(p.name)}</div>
    <div class="ms-product-price">KES ${price.toLocaleString()}${orig > price ? '<span class="ms-product-original-price"> KES ' + orig.toLocaleString() + '</span>' : ''}</div>
    ${p.rating ? '<div class="ms-prod-rating">' + _stars(p.rating) + ' <span class="ms-prod-rating-count">(' + (p.reviewCount || 0) + ')</span></div>' : ''}
  </div>
</div>`;
  }

  // ─── Tab Switching ───────────────────────────────────────────────────────────
  function _setupTabs() {
    const tabBtns = document.querySelectorAll('#msTabs .ms-tab');
    const tabContents = document.querySelectorAll('.ms-tab-content');
    const catalogFilter = document.getElementById('msCatalogFilter');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        tabContents.forEach(c => { c.classList.remove('active'); c.hidden = true; });
        const panel = document.getElementById('ms' + target.charAt(0).toUpperCase() + target.slice(1));
        if (panel) { panel.classList.add('active'); panel.hidden = false; }
        if (catalogFilter) catalogFilter.hidden = target !== 'store' || catalogFilter.dataset.hasTypes !== 'true';
      });
    });
  }

  // ─── Product Sections ────────────────────────────────────────────────────────
  function _renderProductSections(products, shopId) {
    if (!products || !products.length) return;
    _state.allProducts = products;
    _state.shopIdForFilter = shopId;
    _state.productsById = {};
    products.forEach(p => { _state.productsById[p.id] = p; });

    const now = Date.now() / 1000;
    const THIRTY_DAYS = 30 * 86400;
    const bestSellers = products.filter(p => p.isBestseller === true || (p.salesCount || 0) > 10).slice(0, 6);
    const newArrivals = products.filter(p => {
      const ts = p.createdAt?._seconds || p.createdAt?.seconds || 0;
      return ts > now - THIRTY_DAYS;
    }).slice(0, 6);
    const todaysDeals = products.filter(p => (p.discountPercent > 0) || (Number(p.originalPrice || 0) > Number(p.price || 0))).slice(0, 6);
    const shownIds = new Set([...bestSellers, ...newArrivals, ...todaysDeals].map(p => p.id));
    const remaining = products.filter(p => !shownIds.has(p.id));

    function _renderSection(sectionId, gridId, items, seeAllId) {
      const section = document.getElementById(sectionId);
      const grid = document.getElementById(gridId);
      if (!section) return;
      if (!items.length) { section.hidden = true; return; }
      section.hidden = false;
      if (grid) grid.innerHTML = items.map(_productCard).join('');
      if (seeAllId) {
        const seeAll = document.getElementById(seeAllId);
        if (seeAll) seeAll.hidden = false;
      }
    }

    _renderSection('msBestSellersSection', 'msBestSellers', bestSellers, 'msBestSellersAll');
    _renderSection('msNewArrivalsSection', 'msNewArrivals', newArrivals, 'msNewArrivalsAll');
    _renderSection('msTodaysDealsSection', 'msTodaysDeals', todaysDeals, null);

    const allSection = document.getElementById('msAllProductsSection');
    const allGrid = document.getElementById('msProductGrid');
    if (allSection) {
      const showAll = !bestSellers.length && !newArrivals.length && !todaysDeals.length;
      const allItems = showAll ? products : remaining;
      if (allItems.length) {
        allSection.hidden = false;
        if (allGrid) allGrid.innerHTML = allItems.map(_productCard).join('');
        const seeAll = document.getElementById('msAllProductsAll');
        if (seeAll) { seeAll.hidden = false; seeAll.href = 'products.html?shopId=' + shopId; }
      } else {
        allSection.hidden = true;
      }
    }

    _initCatalogFilter(products);
  }

  function _initCatalogFilter(products) {
    const filter = document.getElementById('msCatalogFilter');
    if (!filter) return;
    const types = new Set(products.map(p => p.type || 'product'));
    if (types.size <= 1) { filter.hidden = true; filter.dataset.hasTypes = 'false'; return; }
    filter.hidden = false;
    filter.dataset.hasTypes = 'true';
    filter.querySelectorAll('.ms-cat-btn').forEach(btn => {
      const cat = btn.dataset.cat;
      if (cat !== 'all' && !products.some(p => (p.type || 'product') === cat)) {
        btn.hidden = true; return;
      }
      btn.addEventListener('click', () => {
        filter.querySelectorAll('.ms-cat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _filterProductsByType(cat);
      });
    });
  }

  function _filterProductsByType(cat) {
    const products = _state.allProducts || [];
    const filtered = cat === 'all' ? products : products.filter(p => (p.type || 'product') === cat);
    const allSection = document.getElementById('msAllProductsSection');
    const allGrid = document.getElementById('msProductGrid');
    if (!allSection || !allGrid) return;
    const isCatFilter = cat !== 'all';
    ['msBestSellersSection', 'msNewArrivalsSection', 'msTodaysDealsSection'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.hidden = isCatFilter;
    });
    allSection.hidden = false;
    allGrid.innerHTML = filtered.length
      ? filtered.map(_productCard).join('')
      : '<p style="color:#888;padding:20px;grid-column:1/-1;text-align:center">No items in this category.</p>';
    const title = document.getElementById('msAllProductsTitle');
    if (title) title.textContent = cat === 'all' ? '🛍 All Products' : '🛍 ' + cat.charAt(0).toUpperCase() + cat.slice(1) + 's';
  }

  // ─── Reviews ─────────────────────────────────────────────────────────────────
  function _renderReviewSummary(reviews, shop) {
    const el = document.getElementById('msReviewSummary');
    if (!el) return;
    const avg = shop.rating || 0;
    const total = shop.reviewCount || (reviews && reviews.length) || 0;
    if (!avg && !total) { el.hidden = true; return; }
    el.hidden = false;
    const breakdown = reviews && reviews.length
      ? [5, 4, 3, 2, 1].map(star => {
          const cnt = reviews.filter(r => Math.round(r.rating || 0) === star).length;
          const pct = total ? Math.round(cnt / reviews.length * 100) : 0;
          return `<div class="ms-bar-row">
  <span class="ms-bar-label">${star}★</span>
  <div class="ms-bar-track"><div class="ms-bar-fill" style="width:${pct}%"></div></div>
  <span class="ms-bar-pct">${pct}%</span>
</div>`;
        }).join('')
      : '';
    el.innerHTML = `<div class="ms-rating-summary">
  <div class="ms-rating-big">${avg.toFixed(1)}</div>
  <div class="ms-rating-stars">${_stars(avg)}</div>
  <div class="ms-rating-count">${total} review${total !== 1 ? 's' : ''}</div>
</div>
${breakdown ? '<div class="ms-rating-bars">' + breakdown + '</div>' : ''}
${reviews && reviews.length ? '<div class="ms-reviews-list">' + reviews.slice(0, 5).map(r => `<div class="ms-review-item">
  <div class="ms-review-header">
    <span class="ms-reviewer">${_esc(r.reviewerName || 'Anonymous')}</span>
    <span class="ms-review-stars">${_stars(r.rating)}</span>
    <span class="ms-review-date">${r.createdAt?._seconds ? new Date(r.createdAt._seconds * 1000).toLocaleDateString() : ''}</span>
  </div>
  <div class="ms-review-body">${_esc(r.comment || '')}</div>
</div>`).join('') + '</div>' : ''}`;
  }

  // ─── Business Card ───────────────────────────────────────────────────────────
  function _renderBusinessCard(shop, config) {
    const el = document.getElementById('msBusinessCard');
    if (!el) return;
    const logo = _esc(shop.logoUrl || config.logoUrl || '');
    const name = _esc(shop.name || '');
    const phone = _esc(config.contactPhone || shop.phone || '');
    const email = _esc(config.contactEmail || shop.email || '');
    const loc = _esc(shop.location || config.location || '');
    const handle = _esc(_state.handle || '');
    el.innerHTML = `<div class="ms-bcard">
  ${logo ? '<img class="ms-bcard-logo" src="' + logo + '" alt="' + name + '">' : ''}
  <div class="ms-bcard-name">${name}</div>
  <div class="ms-bcard-meta">
    ${phone ? '📞 ' + phone : ''} ${email ? '· 📧 ' + email : ''} ${loc ? '· 📍 ' + loc : ''}
  </div>
  <div class="ms-bcard-url">mysokoni.co.ke/@${handle}</div>
  <div class="ms-bcard-actions">
    <button onclick="SokoniMiniShop.downloadBusinessCard()">⬇ Save Contact</button>
    <button onclick="SokoniMiniShop.showQR()">📱 QR Code</button>
  </div>
</div>`;
  }

  // ─── OG Meta & Schema ────────────────────────────────────────────────────────
  function _setMeta(name, content, isProp) {
    let el = document.querySelector((isProp ? '[property="' : '[name="') + name + '"]');
    if (!el) { el = document.createElement('meta'); el[isProp ? 'setAttribute' : 'name'] = isProp ? '' : name; if (isProp) el.setAttribute('property', name); document.head.appendChild(el); }
    el.setAttribute('content', content);
  }
  function _applyMeta(shop, config) {
    const name = shop.name || 'SOKONI Shop';
    const desc = config.description || shop.description || 'Shop on SOKONI';
    const img = config.coverUrl || shop.logoUrl || '';
    const url = _state.shopUrl;
    document.title = name + ' | SOKONI';
    _setMeta('description', desc);
    _setMeta('og:title', name, true);
    _setMeta('og:description', desc, true);
    _setMeta('og:image', img, true);
    _setMeta('og:url', url, true);
    _setMeta('og:type', 'business.business', true);
    _setMeta('twitter:card', 'summary_large_image');
    _setMeta('twitter:title', name);
    _setMeta('twitter:description', desc);
    _setMeta('twitter:image', img);
    // Schema.org LocalBusiness
    const existing = document.getElementById('ms-schema');
    if (existing) existing.remove();
    const schema = document.createElement('script');
    schema.id = 'ms-schema';
    schema.type = 'application/ld+json';
    schema.text = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Store',
      name: shop.name || '',
      description: desc,
      url: url,
      image: img,
      telephone: config.contactPhone || '',
      email: config.contactEmail || '',
      address: { '@type': 'PostalAddress', addressCountry: 'KE', addressLocality: shop.location || '' }
    });
    document.head.appendChild(schema);
  }

  // ─── Theme ───────────────────────────────────────────────────────────────────
  function _applyTheme(config) {
    const color = config.brandColor || '#7c4dff';
    document.documentElement.style.setProperty('--ms-brand', color);
    const el = document.getElementById('ms-app');
    if (el && config.fontFamily) el.style.fontFamily = config.fontFamily;
  }

  // ─── WhatsApp Status Mode ─────────────────────────────────────────────────────
  function _renderStatusMode(data) {
    const overlay = document.getElementById('ms-status-mode');
    if (!overlay) return;
    overlay.hidden = false;
    const skel = document.getElementById('ms-skeleton');
    if (skel) skel.hidden = true;
    const app = document.getElementById('ms-app');
    if (app) app.hidden = true;
    const { shop, config, products } = data;
    const prod = products?.[0];
    const img = _esc(prod?.imageUrl || config?.coverUrl || shop?.logoUrl || '');
    const name = _esc(prod?.name || shop?.name || 'Shop Now');
    const price = prod ? 'KES ' + Number(prod.price || 0).toLocaleString() : '';
    const statusEl = document.getElementById('msStatusProduct');
    if (statusEl) {
      statusEl.innerHTML = `<div class="ms-status-img-wrap">
  ${img ? '<img src="' + img + '" alt="' + name + '" class="ms-status-img">' : ''}
</div>
<div class="ms-status-product-info">
  <div class="ms-status-shop-name">${_esc(shop?.name || '')}</div>
  <div class="ms-status-product-name">${name}</div>
  ${price ? '<div class="ms-status-price">' + price + '</div>' : ''}
</div>`;
    }
    const actEl = document.getElementById('msStatusActions');
    if (actEl) {
      const shopUrl = 'https://mysokoni.co.ke/shop/' + (_state.handle || '') + '?utm_source=whatsapp&utm_medium=status';
      const waNum = (_esc(config?.socialLinks?.whatsapp || config?.contactPhone || '')).replace(/[^0-9]/g, '');
      actEl.innerHTML = `<a href="${shopUrl}" class="ms-status-btn ms-status-primary">🛒 Shop Now on SOKONI</a>
<a href="https://wa.me/${waNum}" class="ms-status-btn ms-status-chat">💬 Chat with Seller</a>
${config?.contactPhone ? '<a href="tel:' + _esc(config.contactPhone) + '" class="ms-status-btn ms-status-call">📞 Call</a>' : ''}`;
    }
    _trackView(_state.shopId);
  }

  // ─── Not Found ───────────────────────────────────────────────────────────────
  function _showNotFound() {
    const skel = document.getElementById('ms-skeleton');
    if (skel) skel.hidden = true;
    const nf = document.getElementById('ms-not-found');
    if (nf) nf.hidden = false;
    else document.body.innerHTML = '<div style="text-align:center;padding:80px 20px;font-family:sans-serif"><h2>Shop not found</h2><p>This shop does not exist or may have been removed.</p><a href="/">Return to SOKONI</a></div>';
  }

  // ─── Main Render ─────────────────────────────────────────────────────────────
  function _renderShop(data) {
    const { shop, config, products, services, reviews, totalProducts } = data;
    _state.shop = shop || {};
    _state.config = config || {};
    _state.products = products || [];
    _state.services = services || [];

    // Theme
    _applyTheme(config);

    // Cover
    const cover = document.getElementById('msCover');
    if (cover && config.coverUrl) cover.style.backgroundImage = 'url(' + _esc(config.coverUrl) + ')';

    // Logo
    const logo = document.getElementById('msLogo');
    if (logo && (shop.logoUrl || config.logoUrl)) logo.src = _esc(shop.logoUrl || config.logoUrl);

    // Identity
    _setEl('msShopName', shop.name || '');
    _setEl('msShopCategory', shop.category || '');
    _setEl('msShopTagline', config.tagline || shop.description || '');

    // Announcement
    if (config.announcement) {
      const ann = document.getElementById('msAnnouncement');
      if (ann) { ann.textContent = config.announcement; ann.hidden = false; }
    }

    // Stats bar
    _setEl('msFollowerCount', Number(shop.followerCount || 0).toLocaleString());
    _setEl('msProductCount', Number(totalProducts || products.length).toLocaleString());
    _setEl('msRating', shop.rating ? shop.rating.toFixed(1) : '—');
    _setEl('msReviewCount', Number(shop.reviewCount || (reviews && reviews.length) || 0).toLocaleString());
    _state.followerCount = shop.followerCount || 0;

    // Trust signals
    const trustBar = document.getElementById('msTrustBar');
    if (trustBar) trustBar.innerHTML = _renderTrustSignals(shop, config);

    // Smart CTA
    const ctaEl = document.getElementById('msSmartCta');
    if (ctaEl) {
      const ctas = _getSmartCta(shop.category || config.category || '');
      ctaEl.innerHTML = ctas.map(c =>
        '<button class="ms-cta-btn" onclick="SokoniMiniShop._ctaAction('' + c.action + '')">' + _esc(c.label) + '</button>'
      ).join('');
    }

    // Share panel URL
    _state.shopUrl = 'https://mysokoni.co.ke/shop/' + (_state.handle || shop.handle || '');
    const shareUrlEl = document.getElementById('msShareUrl');
    if (shareUrlEl) shareUrlEl.textContent = _state.shopUrl;

    // Tab switching
    _setupTabs();

    // Product sections
    _renderProductSections(products, _state.shopId);

    // Services section
    if (services && services.length) {
      const svcWrap = document.getElementById('msServicesSection');
      if (svcWrap) {
        svcWrap.hidden = false;
        const grid = svcWrap.querySelector('.ms-svc-grid');
        if (grid) grid.innerHTML = services.map(s => `<div class="ms-svc-card">
  ${s.imageUrl ? '<img class="ms-svc-img" src="' + _esc(s.imageUrl) + '" alt="' + _esc(s.name) + '">' : ''}
  <div class="ms-svc-name">${_esc(s.name)}</div>
  <div class="ms-svc-price">KES ${Number(s.price || 0).toLocaleString()}</div>
  <button class="ms-svc-book" onclick="location.href='venue-booking.html?shopId=${_esc(_state.shopId)}&serviceId=${_esc(s.id)}'">Book</button>
</div>`).join('');
      }
    }

    // Reviews
    _renderReviewSummary(reviews, shop);

    // Hours
    if (config.hours) {
      const hoursEl = document.getElementById('msHours');
      if (hoursEl) {
        const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        hoursEl.innerHTML = days.map(d => {
          const h = config.hours[d.toLowerCase()] || config.hours[d];
          if (!h || h.closed) return '<div class="ms-hour-row"><span>' + d + '</span><span>Closed</span></div>';
          return '<div class="ms-hour-row"><span>' + d + '</span><span>' + _esc(h.open || '') + ' – ' + _esc(h.close || '') + '</span></div>';
        }).join('');
      }
    }

    // Social links
    const socials = config.socialLinks || {};
    const socialItems = [
      { key: 'whatsapp', icon: '📱', base: 'https://wa.me/' },
      { key: 'instagram', icon: '📸', base: 'https://instagram.com/' },
      { key: 'facebook', icon: '👤', base: 'https://facebook.com/' },
      { key: 'tiktok', icon: '🎵', base: 'https://tiktok.com/@' },
      { key: 'twitter', icon: '🐦', base: 'https://x.com/' },
      { key: 'youtube', icon: '▶', base: 'https://youtube.com/' },
      { key: 'website', icon: '🌐', base: '' }
    ];
    const socEl = document.getElementById('msSocials');
    if (socEl) {
      const links = socialItems.filter(s => socials[s.key]).map(s =>
        '<a href="' + _esc(s.base + socials[s.key]) + '" target="_blank" rel="noopener" class="ms-social-link">' + s.icon + ' ' + _esc(s.key) + '</a>'
      ).join('');
      socEl.innerHTML = links || '';
      socEl.hidden = !links;
    }

    // Payment methods
    if (config.paymentMethods && config.paymentMethods.length) {
      const pmEl = document.getElementById('msPaymentMethods');
      if (pmEl) pmEl.innerHTML = config.paymentMethods.map(m => '<span class="ms-pm-badge">' + _esc(m) + '</span>').join('');
    }

    // Delivery info
    if (config.deliveryAreas || config.deliveryPolicy) {
      const dlEl = document.getElementById('msDeliveryInfo');
      if (dlEl) {
        dlEl.hidden = false;
        if (config.deliveryAreas) _setEl('msDeliveryAreas', config.deliveryAreas);
        if (config.deliveryPolicy) _setEl('msDeliveryPolicy', config.deliveryPolicy);
      }
    }

    // Business card
    _renderBusinessCard(shop, config);

    // OG Meta + Schema.org
    _applyMeta(shop, config);

    // Reveal app
    const skeleton = document.getElementById('ms-skeleton');
    if (skeleton) skeleton.hidden = true;
    const app = document.getElementById('ms-app');
    if (app) app.hidden = false;
  }

  // ─── Public: initPublic ───────────────────────────────────────────────────────
  async function initPublic() {
    const handle = _parseHandle();
    if (!handle) { _showNotFound(); return; }
    _state.handle = handle;

    // WhatsApp Status mode check
    const params = new URLSearchParams(location.search);
    const statusMode = params.get('mode') === 'status';

    try {
      const res = await fetch(CF + '/getMinishopPublic?handle=' + encodeURIComponent(handle));
      if (res.status === 404) { _showNotFound(); return; }
      if (!res.ok) throw new Error('Server error ' + res.status);
      const data = await res.json();
      _state.shopId = data.shop?.id || data.shopId || '';

      if (statusMode) {
        _renderStatusMode(data);
        return;
      }

      _renderShop(data);
      _trackView(_state.shopId);
      _checkFollowStatus();
      // v3.0: load supplementary sections in parallel
      const sid = _state.shopId;
      if (sid) {
        Promise.all([
          loadPromotions(sid),
          loadAnnouncements(sid),
          loadSimilar(sid, data.shop && data.shop.category),
        ]).catch(() => {});
      }
    } catch (err) {
      console.error('[MiniShop] initPublic error:', err);
      _showNotFound();
    }
  }

  // ─── Public: initAdmin ────────────────────────────────────────────────────────
  async function initAdmin() {
    _state.adminMode = true;
    if (typeof firebase === 'undefined') { _toast('Firebase not loaded', 'error'); return; }
    firebase.auth().onAuthStateChanged(async user => {
      if (!user) { location.href = 'login.html?redirect=' + encodeURIComponent(location.href); return; }
      _state.currentUser = user;
      _loadAdminAnalytics();
      try {
        const loadEl = document.getElementById('msaLoading');
        if (loadEl) loadEl.hidden = false;
        const data = await _callCF('getMyMinishop', {});
        if (loadEl) loadEl.hidden = true;
        if (!data) return;
        _state.shopId = data.shopId || '';
        _state.handle = data.handle || '';
        _state.config = data.config || {};
        _state.shop = data.shop || {};
        _populateAdminForm(data);
      } catch (err) {
        const loadEl = document.getElementById('msaLoading');
        if (loadEl) loadEl.hidden = true;
        _toast('Failed to load shop data: ' + (err.message || 'Unknown error'), 'error');
      }
    });
  }
  function _populateAdminForm(data) {
    const { shop, config, handle, analytics } = data;
    _setEl('msaShopNameDisplay', shop?.name || '');
    if (handle) {
      _setEl('msaHandleDisplay', '@' + handle);
      _setEl('msaHandleUrl', 'mysokoni.co.ke/shop/' + handle);
      _setVal('msaHandleInput', handle);
      const viewLink = document.getElementById('msaViewShop');
      if (viewLink) viewLink.href = '/shop/' + handle;
    }
    if (config.coverUrl) { const el = document.getElementById('msaCoverPreview'); if (el) { el.src = config.coverUrl; el.hidden = false; } }
    if (shop?.logoUrl || config.logoUrl) { const el = document.getElementById('msaLogoPreview'); if (el) { el.src = shop?.logoUrl || config.logoUrl; el.hidden = false; } }
    _setVal('msaAnnouncement', config.announcement || '');
    _setVal('msaDescription', config.description || '');
    _setVal('msaPhone', config.contactPhone || '');
    _setVal('msaEmail', config.contactEmail || '');
    const sl = config.socialLinks || {};
    _setVal('msaWhatsapp', sl.whatsapp || '');
    _setVal('msaInstagram', sl.instagram || '');
    _setVal('msaFacebook', sl.facebook || '');
    _setVal('msaTiktok', sl.tiktok || '');
    _setVal('msaTwitter', sl.twitter || '');
    _setVal('msaYoutube', sl.youtube || '');
    _setVal('msaWebsite', sl.website || '');
    _setVal('msaResponseTime', config.responseTime || '');
    _setVal('msaDeliveryAreas', config.deliveryAreas || '');
    _setVal('msaDeliveryPolicy', config.deliveryPolicy || '');
    // Brand color
    if (config.brandColor) {
      const btns = document.querySelectorAll('#msaColorSwatches .ms-color-btn');
      btns.forEach(b => b.classList.toggle('active', b.dataset.color === config.brandColor));
      const custom = document.getElementById('msaCustomColor');
      if (custom) custom.value = config.brandColor;
    }
    // Payment methods
    if (config.paymentMethods && config.paymentMethods.length) {
      const pmEl = document.getElementById('msaPaymentMethods');
      if (pmEl) {
        pmEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
          cb.checked = config.paymentMethods.includes(cb.value);
        });
      }
    }
    // Hours
    _renderAdminHours(config.hours || {});
    // Share links
    if (data.handle) {
      const shareEl = document.getElementById('msaShareLinks');
      if (shareEl) {
        const url = 'https://mysokoni.co.ke/shop/' + handle;
        shareEl.innerHTML = _buildShareLinks(url);
      }
    }
  }
  function _renderAdminHours(hours) {
    const wrap = document.getElementById('msaHours');
    if (!wrap) return;
    const days = [
      { key: 'mon', label: 'Monday' }, { key: 'tue', label: 'Tuesday' },
      { key: 'wed', label: 'Wednesday' }, { key: 'thu', label: 'Thursday' },
      { key: 'fri', label: 'Friday' }, { key: 'sat', label: 'Saturday' },
      { key: 'sun', label: 'Sunday' }
    ];
    wrap.innerHTML = days.map(d => {
      const h = hours[d.key] || {};
      const closed = h.closed || false;
      return `<div class="ms-hours-row" id="msaHoursRow_${d.key}">
  <label class="ms-hours-label"><input type="checkbox" onchange="SokoniMiniShop._toggleDay('${d.key}', this.checked)" ${closed ? '' : 'checked'}> ${d.label}</label>
  <div class="ms-hours-inputs" ${closed ? 'hidden' : ''}>
    <input type="time" id="msaHoursOpen_${d.key}" value="${_esc(h.open || '08:00')}" class="ms-hours-time">
    <span>–</span>
    <input type="time" id="msaHoursClose_${d.key}" value="${_esc(h.close || '18:00')}" class="ms-hours-time">
  </div>
</div>`;
    }).join('');
  }
  function _getAdminHours() {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const hours = {};
    days.forEach(d => {
      const openEl = document.getElementById('msaHoursOpen_' + d);
      const closeEl = document.getElementById('msaHoursClose_' + d);
      const row = document.getElementById('msaHoursRow_' + d);
      const cb = row && row.querySelector('input[type=checkbox]');
      if (cb && !cb.checked) { hours[d] = { closed: true }; return; }
      hours[d] = { open: openEl ? openEl.value : '08:00', close: closeEl ? closeEl.value : '18:00', closed: false };
    });
    return hours;
  }
  async function _loadAdminAnalytics() {
    if (!_state.shopId) return;
    try {
      const data = await _callCF('getMinishopAnalytics', { shopId: _state.shopId });
      if (!data) return;
      _setEl('msaViewsToday', data.viewsToday || 0);
      _setEl('msaTotalViews', data.totalViews || 0);
      _setEl('msaFollowers', data.followers || 0);
      _setEl('msaOrdersFromShop', data.ordersFromShop || 0);
      const bodyEl = document.getElementById('msaAnalyticsBody');
      if (bodyEl && data.recent) {
        bodyEl.innerHTML = data.recent.map(r =>
          '<tr><td>' + _esc(r.date || '') + '</td><td>' + (r.views || 0) + '</td><td>' + (r.clicks || 0) + '</td><td>' + _esc(r.source || '') + '</td></tr>'
        ).join('') || '<tr><td colspan="4" style="text-align:center;color:#888">No data yet</td></tr>';
      }
    } catch (_) { /* analytics failure is non-fatal */ }
  }

  // ─── Public: claimHandle ─────────────────────────────────────────────────────
  async function claimHandle() {
    const el = document.getElementById('msaHandleInput');
    if (!el) return;
    const handle = el.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!handle || handle.length < 3) { _toast('Handle must be at least 3 characters', 'warning'); return; }
    const btn = document.getElementById('msaClaimBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Claiming…'; }
    try {
      const res = await _callCF('claimMinishopHandle', { handle });
      _state.handle = handle;
      _setEl('msaHandleDisplay', '@' + handle);
      _setEl('msaHandleUrl', 'mysokoni.co.ke/shop/' + handle);
      const vl = document.getElementById('msaViewShop');
      if (vl) vl.href = '/shop/' + handle;
      _toast('@' + handle + ' claimed!', 'success');
    } catch (err) {
      _toast(err.message || 'Handle not available', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Claim'; }
    }
  }

  // ─── Public: saveConfig ───────────────────────────────────────────────────────
  async function saveConfig() {
    const btn = document.getElementById('msaSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const pmEl = document.getElementById('msaPaymentMethods');
      const paymentMethods = pmEl
        ? Array.from(pmEl.querySelectorAll('input[type=checkbox]:checked')).map(c => c.value)
        : [];
      const config = {
        announcement: (document.getElementById('msaAnnouncement')?.value || '').slice(0, 200),
        description: (document.getElementById('msaDescription')?.value || '').slice(0, 1000),
        contactPhone: document.getElementById('msaPhone')?.value || '',
        contactEmail: document.getElementById('msaEmail')?.value || '',
        brandColor: document.getElementById('msaCustomColor')?.value || '#7c4dff',
        socialLinks: {
          whatsapp: document.getElementById('msaWhatsapp')?.value || '',
          instagram: document.getElementById('msaInstagram')?.value || '',
          facebook: document.getElementById('msaFacebook')?.value || '',
          tiktok: document.getElementById('msaTiktok')?.value || '',
          twitter: document.getElementById('msaTwitter')?.value || '',
          youtube: document.getElementById('msaYoutube')?.value || '',
          website: document.getElementById('msaWebsite')?.value || ''
        },
        responseTime: document.getElementById('msaResponseTime')?.value || '',
        deliveryAreas: document.getElementById('msaDeliveryAreas')?.value || '',
        deliveryPolicy: document.getElementById('msaDeliveryPolicy')?.value || '',
        paymentMethods,
        hours: _getAdminHours(),
        coverUrl: _state.config.coverUrl || '',
        logoUrl: _state.config.logoUrl || ''
      };
      await _callCF('saveMinishopConfig', { shopId: _state.shopId, config });
      _state.config = config;
      _toast('Shop saved!', 'success');
    } catch (err) {
      _toast('Save failed: ' + (err.message || 'Unknown error'), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
    }
  }

  // ─── Public: generateContent ─────────────────────────────────────────────────
  async function generateContent() {
    const typeEl = document.getElementById('msaAiType');
    const ctxEl = document.getElementById('msaAiContext');
    const outEl = document.getElementById('msaAiOutput');
    const copyEl = document.getElementById('msaAiCopy');
    const histEl = document.getElementById('msaAiHistory');
    const genBtn = document.getElementById('msaAiGenerate');
    if (!typeEl || !ctxEl) return;
    const type = typeEl.value;
    const context = ctxEl.value.trim();
    if (!context) { _toast('Provide some context for AI generation', 'warning'); return; }
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = 'Generating…'; }
    if (outEl) outEl.textContent = 'Thinking…';
    try {
      const res = await _callCF('aiGenerateMinishopContent', { type, context, shopId: _state.shopId });
      const text = res.content || res.result || '';
      if (outEl) outEl.textContent = text;
      if (copyEl) copyEl.hidden = false;
      if (histEl && text) {
        const item = document.createElement('div');
        item.className = 'ms-ai-history-item';
        item.textContent = '[' + type + '] ' + text.slice(0, 80) + (text.length > 80 ? '…' : '');
        item.onclick = () => { if (outEl) outEl.textContent = text; };
        histEl.prepend(item);
      }
    } catch (err) {
      if (outEl) outEl.textContent = 'Generation failed: ' + (err.message || 'Unknown error');
      _toast('AI generation failed', 'error');
    } finally {
      if (genBtn) { genBtn.disabled = false; genBtn.textContent = 'Generate'; }
    }
  }

  // ─── Share ────────────────────────────────────────────────────────────────────
  function _buildShareLinks(url) {
    const text = encodeURIComponent((_state.shop.name || 'Check this shop') + ' on SOKONI');
    const enc = encodeURIComponent(url);
    const platforms = [
      { key: 'whatsapp', label: 'WhatsApp', color: '#25d366', icon: 'W', href: 'https://wa.me/?text=' + text + '%20' + enc },
      { key: 'instagram', label: 'Instagram', color: '#e1306c', icon: 'Ig', href: '#', onclick: 'SokoniMiniShop.copyLink()' },
      { key: 'facebook', label: 'Facebook', color: '#1877f2', icon: 'f', href: 'https://www.facebook.com/sharer/sharer.php?u=' + enc },
      { key: 'x', label: 'X', color: '#000', icon: 'X', href: 'https://x.com/intent/tweet?url=' + enc + '&text=' + text },
      { key: 'telegram', label: 'Telegram', color: '#2aabee', icon: 'Tg', href: 'https://t.me/share/url?url=' + enc + '&text=' + text },
      { key: 'linkedin', label: 'LinkedIn', color: '#0077b5', icon: 'in', href: 'https://www.linkedin.com/sharing/share-offsite/?url=' + enc },
      { key: 'qr', label: 'QR Code', color: '#7c4dff', icon: '▦', href: '#', onclick: 'SokoniMiniShop.showQR()' },
      { key: 'status', label: 'WA Status', color: '#128c7e', icon: '◉', href: url + '?mode=status', target: '_blank' }
    ];
    return platforms.map(p =>
      '<a class="ms-share-item" style="--sc:' + p.color + '" href="' + _esc(p.href) + '"' +
      (p.target ? ' target="_blank" rel="noopener"' : '') +
      (p.onclick ? ' onclick="' + p.onclick + ';return false;"' : '') + '>' +
      '<span class="ms-share-icon">' + p.icon + '</span>' +
      '<span class="ms-share-label">' + p.label + '</span></a>'
    ).join('');
  }
  function share(platform) {
    const url = _state.shopUrl || location.href;
    const text = encodeURIComponent((_state.shop.name || 'Check this out') + ' on SOKONI');
    const enc = encodeURIComponent(url);
    const targets = {
      whatsapp: 'https://wa.me/?text=' + text + '%20' + enc,
      facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + enc,
      x: 'https://x.com/intent/tweet?url=' + enc + '&text=' + text,
      telegram: 'https://t.me/share/url?url=' + enc + '&text=' + text,
      linkedin: 'https://www.linkedin.com/sharing/share-offsite/?url=' + enc,
      instagram: null
    };
    if (platform === 'instagram' || platform === 'qr') { if (platform === 'qr') showQR(); else { copyLink(); _toast('Link copied — paste in Instagram bio', 'info'); } return; }
    const target = targets[platform];
    if (target) window.open(target, '_blank', 'width=600,height=450');
    else { copyLink(); }
  }
  function copyLink() {
    const url = _state.shopUrl || location.href;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => _toast('Link copied!', 'success')).catch(() => _fallbackCopy(url));
    } else {
      _fallbackCopy(url);
    }
  }
  function _fallbackCopy(url) {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); _toast('Link copied!', 'success'); } catch (_) { _toast('Copy failed — copy manually: ' + url, 'warning'); }
    ta.remove();
  }
  function toggleSharePanel() {
    const panel = document.getElementById('msSharePanel');
    if (!panel) return;
    const isHidden = panel.hidden;
    panel.hidden = !isHidden;
    if (isHidden) {
      const grid = document.getElementById('msShareGrid');
      if (grid) grid.innerHTML = _buildShareLinks(_state.shopUrl || location.href);
    }
  }

  // ─── QR ──────────────────────────────────────────────────────────────────────
  function showQR() {
    const modal = document.getElementById('msQrModal');
    const url = _state.shopUrl || location.href;
    const qrImg = document.getElementById('msQrImg');
    if (qrImg) qrImg.src = _qrUrl(url);
    if (modal) modal.hidden = false;
  }
  function downloadQR() {
    const url = _state.shopUrl || location.href;
    const link = document.createElement('a');
    link.href = _qrUrl(url);
    link.download = (_state.handle || 'shop') + '-qr.png';
    link.click();
  }
  function printPoster() {
    const url = _state.shopUrl || location.href;
    const qr = _qrUrl(url);
    const name = _esc(_state.shop.name || 'Our Shop');
    const w = window.open('', '_blank');
    if (!w) { _toast('Please allow popups to print', 'warning'); return; }
    w.document.write(`<!DOCTYPE html><html><head><title>QR Poster</title><style>
body{margin:0;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f5f5f5;}
.poster{background:#fff;border-radius:16px;padding:48px 40px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.1);max-width:420px;}
.poster h1{font-size:28px;margin-bottom:8px;color:#1a1a1a;}
.poster img{width:220px;height:220px;margin:20px auto;display:block;}
.poster p{font-size:16px;color:#444;margin:0;}
.poster .url{font-size:13px;color:#7c4dff;margin-top:12px;word-break:break-all;}
.poster .brand{font-size:12px;color:#aaa;margin-top:24px;}
</style></head><body>
<div class="poster">
  <h1>${name}</h1>
  <p>Scan to visit our shop</p>
  <img src="${_esc(qr)}" alt="QR Code">
  <div class="url">${_esc(url)}</div>
  <div class="brand">SOKONI — Kenya's Marketplace</div>
</div>
</body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
  }

  // ─── Follow ───────────────────────────────────────────────────────────────────
  async function toggleFollow() {
    if (typeof firebase === 'undefined') { _toast('Please log in to follow shops', 'info'); return; }
    const user = firebase.auth().currentUser;
    if (!user) { location.href = 'login.html?redirect=' + encodeURIComponent(location.href); return; }
    if (!_state.shopId) return;
    try {
      const action = _state.following ? 'unfollow' : 'follow';
      await _callCF('toggleShopFollow', { shopId: _state.shopId, action });
      _state.following = !_state.following;
      _state.followerCount += _state.following ? 1 : -1;
      _setEl('msFollowerCount', Math.max(0, _state.followerCount).toLocaleString());
      _updateFollowBtn();
      _toast(_state.following ? 'Following this shop' : 'Unfollowed', 'success');
    } catch (err) {
      _toast('Could not update follow: ' + (err.message || ''), 'error');
    }
  }

  // ─── Business Card Download ──────────────────────────────────────────────────
  function downloadBusinessCard() {
    const shop = _state.shop;
    const config = _state.config;
    const name = shop.name || 'Business';
    const phone = config.contactPhone || shop.phone || '';
    const email = config.contactEmail || shop.email || '';
    const handle = _state.handle || '';
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:' + name,
      'ORG:' + name,
      phone ? 'TEL;TYPE=CELL:' + phone : '',
      email ? 'EMAIL:' + email : '',
      'URL:https://mysokoni.co.ke/shop/' + handle,
      'NOTE:Find us on SOKONI - Kenya's marketplace',
      'END:VCARD'
    ].filter(Boolean).join('\r\n');
    const blob = new Blob([vcard], { type: 'text/vcard' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (handle || 'contact') + '.vcf';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Cart Stub ────────────────────────────────────────────────────────────────
  function openCart() {
    if (typeof SokoniCart !== 'undefined' && SokoniCart.open) { SokoniCart.open(); return; }
    location.href = 'checkout.html?shopId=' + (_state.shopId || '');
  }

  // ─── Admin: Color Picker ─────────────────────────────────────────────────────
  function _selectColor(color, btn) {
    const btns = document.querySelectorAll('#msaColorSwatches .ms-color-btn');
    btns.forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const cc = document.getElementById('msaCustomColor');
    if (cc) cc.value = color;
  }

  // ─── Admin: Hours Toggle ─────────────────────────────────────────────────────
  function _toggleDay(key, open) {
    const inputs = document.querySelector('#msaHoursRow_' + key + ' .ms-hours-inputs');
    if (inputs) inputs.hidden = !open;
  }

  // ─── Admin: Image Upload ──────────────────────────────────────────────────────
  async function _handleImageUpload(inputId, previewId, configKey) {
    const input = document.getElementById(inputId);
    if (!input || !input.files || !input.files[0]) return;
    const file = input.files[0];
    if (file.size > 5 * 1024 * 1024) { _toast('Image must be under 5MB', 'warning'); return; }
    if (!file.type.startsWith('image/')) { _toast('Please select an image file', 'warning'); return; }
    try {
      const user = firebase.auth().currentUser;
      if (!user) throw new Error('Not authenticated');
      const path = 'minishops/' + user.uid + '/' + configKey + '_' + _today() + '.' + file.name.split('.').pop();
      const ref = firebase.storage().ref(path);
      const snap = await ref.put(file);
      const url = await snap.ref.getDownloadURL();
      const prev = document.getElementById(previewId);
      if (prev) { prev.src = url; prev.hidden = false; }
      _state.config[configKey] = url;
      _toast('Image uploaded', 'success');
    } catch (err) {
      _toast('Upload failed: ' + (err.message || ''), 'error');
    }
  }

  // ─── Admin: AI Copy ──────────────────────────────────────────────────────────
  function _copyAiOutput() {
    const el = document.getElementById('msaAiOutput');
    if (!el || !el.textContent) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(el.textContent).then(() => _toast('Copied!', 'success'));
    } else {
      _fallbackCopy(el.textContent);
    }
  }

  // ─── Admin: Copy Handle ──────────────────────────────────────────────────────
  function _copyHandle() {
    const url = 'https://mysokoni.co.ke/shop/' + (_state.handle || '');
    copyLink.call({ _state: { shopUrl: url } });
    _state.shopUrl = _state.shopUrl || url;
    copyLink();
  }

  // ─── Admin: QR Buttons ────────────────────────────────────────────────────────
  function _adminQr() {
    _state.shopUrl = 'https://mysokoni.co.ke/shop/' + (_state.handle || '');
    showQR();
  }

  // ─── Init DOM Bindings (admin) ────────────────────────────────────────────────
  function _bindAdminDom() {
    const bind = (id, evt, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); };
    bind('msaCoverInput', 'change', () => _handleImageUpload('msaCoverInput', 'msaCoverPreview', 'coverUrl'));
    bind('msaLogoInput', 'change', () => _handleImageUpload('msaLogoInput', 'msaLogoPreview', 'logoUrl'));
    bind('msaSaveBtn', 'click', saveConfig);
    bind('msaClaimBtn', 'click', claimHandle);
    bind('msaAiGenerate', 'click', generateContent);
    bind('msaAiCopy', 'click', _copyAiOutput);
    bind('msaCopyHandle', 'click', _copyHandle);
    bind('msaQrBtn', 'click', _adminQr);
    bind('msaQrDownload', 'click', downloadQR);
    bind('msaPrintPoster', 'click', printPoster);
  }

  // ─── v3.0: Promotions ────────────────────────────────────────────────────────
  async function loadPromotions(shopId) {
    const el = document.getElementById('msPromotionsSection');
    if (!el) return;
    try {
      const r = await _callCF('miniShopGetPromotions', { shopId });
      const promos = (r && r.promotions) || [];
      if (!promos.length) { el.hidden = true; return; }
      el.hidden = false;
      const grid = document.getElementById('msPromosGrid');
      if (!grid) return;
      grid.innerHTML = promos.map(p => {
        const icon = p.type === 'flash_sale' ? '⚡' : p.type === 'bundle' ? '🎁' : p.type === 'seasonal' ? '🌟' : '🏷️';
        const badge = p.discountType === 'percent' ? `${p.discountValue}% OFF` : `KES ${p.discountValue} OFF`;
        const expires = p.validUntil ? new Date(p.validUntil._seconds ? p.validUntil._seconds * 1000 : p.validUntil).toLocaleDateString('en-KE', { month: 'short', day: 'numeric' }) : '';
        const codeHtml = p.code ? `<div class="ms-promo-code" onclick="navigator.clipboard.writeText('${_esc(p.code)}');SokoniMiniShop._toast('Code copied!','success')" title="Click to copy">${_esc(p.code)}</div>` : '';
        return `<div class="ms-promo-card ${p.type === 'flash_sale' ? 'flash' : p.type === 'bundle' ? 'bundle' : 'coupon'}">
          <div class="ms-promo-icon">${icon}</div>
          <div class="ms-promo-body">
            <div class="ms-promo-title">${_esc(p.title)}</div>
            <div class="ms-promo-desc">${_esc(p.description || '')}</div>
            ${codeHtml}
            ${expires ? `<div class="ms-promo-timer">Ends ${expires}</div>` : ''}
          </div>
          <div class="ms-promo-badge ${p.type === 'flash_sale' ? 'flash' : p.type === 'bundle' ? 'bundle' : 'coupon'}">${badge}</div>
        </div>`;
      }).join('');
    } catch (e) { el.hidden = true; }
  }

  // ─── v3.0: Wishlist ──────────────────────────────────────────────────────────
  async function toggleWishlist(productId) {
    const user = firebase.auth().currentUser;
    if (!user) { _toast('Sign in to save items', 'info'); return; }
    const p = (_state.productsById || {})[productId] || {};
    const shopId = _state.shopId || '';
    try {
      const r = await _callCF('miniShopToggleWishlist', {
        productId,
        shopId,
        productName: p.name || '',
        productPrice: p.price || 0,
        productImage: p.imageUrl || (p.images && p.images[0]) || ''
      });
      const btns = document.querySelectorAll(`.ms-wishlist-btn[onclick*="${productId}"]`);
      btns.forEach(btn => btn.classList.toggle('active', !!(r && r.added)));
      _toast(r && r.added ? 'Saved to wishlist' : 'Removed from wishlist', 'info');
    } catch (e) { _toast('Could not update wishlist', 'error'); }
  }

  // ─── v3.0: Per-product share ─────────────────────────────────────────────────
  async function shareProduct(productId, shopId, name, price) {
    try {
      const r = await _callCF('miniShopShareProduct', { productId, shopId, productName: name, productPrice: price });
      if (r && r.shareUrls) {
        if (navigator.share) {
          navigator.share({ title: name, text: r.shareText, url: r.productUrl || location.href }).catch(() => {});
        } else {
          navigator.clipboard.writeText(r.productUrl || location.href);
          _toast('Product link copied!', 'success');
        }
      }
    } catch (e) {
      navigator.clipboard.writeText(location.href + '?p=' + productId);
      _toast('Link copied!', 'success');
    }
  }

  // ─── v3.0: Announcements ─────────────────────────────────────────────────────
  async function loadAnnouncements(shopId) {
    const el = document.getElementById('msAnnouncementsSection');
    if (!el) return;
    try {
      const r = await _callCF('miniShopGetAnnouncements', { shopId, limit: 3 });
      const posts = (r && r.announcements) || [];
      if (!posts.length) { el.hidden = true; return; }
      el.hidden = false;
      const list = document.getElementById('msAnnounceList');
      if (!list) return;
      list.innerHTML = posts.map(p => {
        const ts = p.createdAt ? new Date(p.createdAt._seconds ? p.createdAt._seconds * 1000 : p.createdAt).toLocaleDateString('en-KE', { month: 'short', day: 'numeric' }) : '';
        return `<div class="ms-announce-item ${_esc(p.type || 'general')}">
          <div class="ms-announce-title">${_esc(p.title)}</div>
          <div class="ms-announce-msg">${_esc(p.message)}</div>
          ${ts ? `<div class="ms-announce-time">${ts}</div>` : ''}
        </div>`;
      }).join('');
    } catch (e) { el.hidden = true; }
  }

  // ─── v3.0: Similar shops ─────────────────────────────────────────────────────
  async function loadSimilar(shopId, category) {
    const el = document.getElementById('msSimilarSection');
    if (!el) return;
    try {
      const r = await _callCF('miniShopGetSimilar', { shopId, category, limit: 6 });
      const shops = (r && r.shops) || [];
      if (!shops.length) { el.hidden = true; return; }
      el.hidden = false;
      const grid = document.getElementById('msSimilarGrid');
      if (!grid) return;
      grid.innerHTML = shops.map(s => {
        const url = s.handle ? `/shop/${_esc(s.handle)}` : '#';
        const logo = s.logoUrl ? `<img class="ms-similar-logo" src="${_esc(s.logoUrl)}" alt="" loading="lazy">` : `<div class="ms-similar-logo" style="background:#1a1a1a;display:flex;align-items:center;justify-content:center;font-size:18px;">${_esc((s.name||'?')[0].toUpperCase())}</div>`;
        return `<a class="ms-similar-card" href="${url}">
          ${logo}
          <div class="ms-similar-name">${_esc(s.name || '')}</div>
          <div class="ms-similar-cat">${_esc(s.category || '')}</div>
          ${s.rating ? `<div class="ms-similar-rating">★ ${Number(s.rating).toFixed(1)}</div>` : ''}
        </a>`;
      }).join('');
    } catch (e) { el.hidden = true; }
  }

  // ─── _ctaAction exposed ───────────────────────────────────────────────────────
  // (defined inline above, referenced by rendered buttons)

  // ─── Public API ──────────────────────────────────────────────────────────────
  return {
    initPublic,
    initAdmin,
    share,
    copyLink,
    toggleSharePanel,
    showQR,
    downloadQR,
    printPoster,
    toggleFollow,
    downloadBusinessCard,
    openCart,
    claimHandle,
    saveConfig,
    generateContent,
    _selectColor,
    _toggleDay,
    _toast,
    _ctaAction,
    _bindAdminDom,
    loadPromotions,
    toggleWishlist,
    shareProduct,
    loadAnnouncements,
    loadSimilar
  };
})();
