/* ================================================================
   SOKONI Universal Market Actions  v1.0
   Adds any item from any page to the shared cart / wishlist.

   Usage (anywhere on any page):
     SokoniMarket.addToCart({ id, name, price, image, category, sourceUrl });
     SokoniMarket.addToWishlist({ id, name, price, image, category });
     SokoniMarket.toggleWishlist(item);   // add or remove
     SokoniMarket.isInCart(id)            // → boolean
     SokoniMarket.isInWishlist(id)        // → boolean

   Cart items saved as "cart" key in localStorage: array of { id, name, price, image, ... }.
   Wishlist is NOT local — it is canonical (wishlistItems/{uid}_{productId}) and reached
   only through SokoniWishlist. This header used to claim a localStorage["wishlist"] key;
   that model is retired and no code here writes it.
================================================================ */
window.SokoniMarket = (function(){

  /* ── Normalise any item into the cart/wishlist shape ── */
  function _norm(raw){
    return {
      id:          raw.id       || ('ext_'+Date.now()+'_'+Math.random().toString(36).slice(2,6)),
      name:        raw.name     || 'Item',
      price:       Number(raw.price||raw.fee||raw.rate||0),
      image:       raw.image    || raw.photo || raw.img || 'assets/default-product.png',
      category:    raw.category || raw.type  || raw.cat || 'Service',
      sellerName:  raw.sellerName || raw.provider || raw.facilityName || raw.name || '',
      sourceUrl:   raw.sourceUrl  || raw.url || '',
      source:      raw.source     || 'marketplace',
      addedAt:     Date.now(),
    };
  }

  /* ── Load / save helpers ── */
  /* Returning [] on a parse failure meant the next _saveCart wrote that empty
     array over the customer's real cart. Quarantine the raw value first so the
     data survives and the failure is visible. */
  function _readList(key){
    const raw = localStorage.getItem(key);
    if (raw == null || raw === '') return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      throw new Error(key + ' was ' + typeof parsed + ', expected an array');
    } catch (e) {
      try { localStorage.setItem(key + '_corrupt_' + Date.now(), raw); } catch (_) {}
      console.error('[SOKONI] ' + key + ' unreadable — quarantined, not overwritten: ' + e.message);
      return [];
    }
  }
  function _loadCart(){     return _readList('cart');     }
  function _saveCart(arr){     localStorage.setItem('cart',     JSON.stringify(arr)); _syncBadges(); _emitCartChanged(arr.length); }

  /* WISHLIST persistence is NOT here any more.
     This file is loaded by car-hub, category, healthcare, index and services, and it held
     a complete second wishlist implementation writing localStorage['wishlist']. That made
     it a live legacy writer on the very pages whose own scripts had already been migrated:
     a card button here and the page's own heart wrote to different places and disagreed.
     SokoniWishlist is the single authority; this file now only renders its state. */
  function _wl(){ return window.SokoniWishlist || null; }
  function _wishCount(){ const w = _wl(); return w ? w.count() : 0; }

  /* _syncBadges only reaches badges matching its own selectors, which do NOT
     include the header pip. The event is what covers everything else. */
  function _emitCartChanged(count){
    try { window.dispatchEvent(new CustomEvent("sokoni:cart-changed", { detail: { count: count } })); } catch (_) {}
  }

  /* ── Update any cart count badges visible on the current page ── */
  function _syncBadges(){
    const cartLen = _loadCart().length;
    const wishLen = _wishCount();          /* canonical, via SokoniWishlist */
    document.querySelectorAll('[data-cart-count],[class*="cart-count"],[id="cartCount"],[id*="cart-count"]').forEach(el=>{ el.textContent=cartLen; el.style.display=cartLen?'flex':'none'; });
    document.querySelectorAll('[data-wish-count],[class*="wish-count"],[id*="wishCount"],[id*="wish-count"]').forEach(el=>{ el.textContent=wishLen; el.style.display=wishLen?'flex':'none'; });
  }

  /* ── Toast notification ── */
  let _toastTimer = null;
  function _toast(msg, color){
    color = color || '#71ff00';
    let t = document.getElementById('_sokoniMktToast');
    if(!t){
      t = document.createElement('div');
      t.id = '_sokoniMktToast';
      t.style.cssText = [
        'position:fixed','bottom:88px','left:50%',
        'transform:translateX(-50%) translateY(60px)',
        'background:#111','border-radius:50px',
        'padding:11px 22px','font-size:13px','font-weight:700',
        'z-index:99999','transition:transform .3s,opacity .3s',
        'pointer-events:none','white-space:nowrap','opacity:0',
        'box-shadow:0 4px 20px rgba(0,0,0,0.6)',
        'font-family:\'Segoe UI\',system-ui,sans-serif'
      ].join(';');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.color = color;
    t.style.border = '1px solid '+color+'55';
    clearTimeout(_toastTimer);
    requestAnimationFrame(()=>{
      t.style.transform='translateX(-50%) translateY(0)';
      t.style.opacity='1';
    });
    _toastTimer = setTimeout(()=>{
      t.style.transform='translateX(-50%) translateY(60px)';
      t.style.opacity='0';
      setTimeout(()=>{ if(t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, 2800);
  }

  /* ── Button state helpers ── */
  function _refreshButtons(id){
    const inCart = isInCart(id), inWish = isInWishlist(id);
    document.querySelectorAll(`[data-cart-id="${id}"]`).forEach(btn=>{
      btn.classList.toggle('_smk-active', inCart);
      btn.title = inCart ? 'Remove from cart' : 'Add to cart';
      btn.innerHTML = inCart ? '🛒 ✓' : '🛒';
    });
    document.querySelectorAll(`[data-wish-id="${id}"]`).forEach(btn=>{
      btn.classList.toggle('_smk-active', inWish);
      btn.title = inWish ? 'Remove from wishlist' : 'Add to wishlist';
      btn.innerHTML = inWish ? '❤️' : '🤍';
    });
  }

  /* ── Public API ── */

  function addToCart(raw){
    const item = _norm(raw);
    const cart = _loadCart();
    const exists = cart.find(c=>c.id===item.id);
    if(exists){ _toast('Already in cart 🛒', '#fbbf24'); return false; }
    cart.push(item);
    _saveCart(cart);
    _refreshButtons(item.id);
    _toast('Added to cart 🛒', '#71ff00');
    return true;
  }

  function removeFromCart(id){
    _saveCart(_loadCart().filter(c=>c.id!==String(id)));
    _refreshButtons(id);
    _toast('Removed from cart', '#ff6b6b');
  }

  /* All three now await the canonical operation before touching the UI. Previously the
     toast and button state were applied first and could never report a failure, because
     a localStorage write does not fail the way a server call does. */
  function addToWishlist(raw){
    const item = _norm(raw), w = _wl();
    if(!w){ _toast('Wishlist is still loading', '#fbbf24'); return Promise.resolve(false); }
    if(w.isWishlisted(item.id)){ _toast('Already in wishlist ❤️', '#fbbf24'); return Promise.resolve(false); }
    return w.add({ productId: item.id, shopId: item.shopId || null,
                   name: item.name, price: item.price, image: item.image })
      .then(function(){ _refreshButtons(item.id); _toast('Added to wishlist ❤️', '#f472b6'); return true; })
      .catch(function(e){
        _toast(/sign in/i.test((e && e.message) || '') ? 'Sign in to save items'
                                                       : "Couldn't save — try again", '#ff6b6b');
        return false;
      });
  }

  function removeFromWishlist(id){
    const w = _wl();
    if(!w){ _toast('Wishlist is still loading', '#fbbf24'); return Promise.resolve(false); }
    return w.remove(String(id))
      .then(function(){ _refreshButtons(id); _toast('Removed from wishlist', '#ff6b6b'); return true; })
      .catch(function(){ _toast("Couldn't update — try again", '#ff6b6b'); return false; });
  }

  function toggleWishlist(raw){
    const item = _norm(raw);
    return isInWishlist(item.id) ? removeFromWishlist(item.id) : addToWishlist(item);
  }

  function toggleCart(raw){
    const item = _norm(raw);
    isInCart(item.id) ? removeFromCart(item.id) : addToCart(item);
  }

  function isInCart(id){     return !!_loadCart().find(c=>c.id===String(id)); }
  /* Stays synchronous, but reads SokoniWishlist's in-memory view of canonical state
     rather than a second store. That view is populated by load() and refreshed on every
     canonical change, so this is a projection of the authority — not another copy of it.
     Deliberately NOT `let wishlist = [...]`: nothing here can be written to. */
  function isInWishlist(id){ const w = _wl(); return !!(w && w.isWishlisted(String(id))); }

  /* ── Inject button pair HTML ── */
  /* Returns a string of two <button> elements to embed in any card. */
  function btnHTML(item, opts){
    opts = opts || {};
    const id   = item.id || ('ext_'+Math.random().toString(36).slice(2,8));
    const inC  = isInCart(id), inW = isInWishlist(id);
    const size = opts.size || '11px';
    const pad  = opts.pad  || '6px 12px';
    const base = `border-radius:8px;cursor:pointer;font-family:inherit;font-weight:700;font-size:${size};padding:${pad};transition:all .18s;border:1px solid;`;
    /* Serialise item for onclick (escape quotes) */
    const json = JSON.stringify(item).replace(/'/g,"\\'").replace(/"/g,'&quot;');
    return `
      <button type="button"
        data-cart-id="${id}"
        title="${inC?'Remove from cart':'Add to cart'}"
        onclick="event.stopPropagation();SokoniMarket.toggleCart(JSON.parse(this.dataset.item))"
        data-item='${JSON.stringify(item).replace(/'/g,"&#39;")}'
        style="${base}background:rgba(113,255,0,${inC?'0.15':'0.07'});border-color:rgba(113,255,0,${inC?'0.4':'0.2'});color:#71ff00;"
      >${inC?'🛒 ✓':'🛒'}</button>
      <button type="button"
        data-wish-id="${id}"
        title="${inW?'Remove from wishlist':'Add to wishlist'}"
        onclick="event.stopPropagation();SokoniMarket.toggleWishlist(JSON.parse(this.dataset.item))"
        data-item='${JSON.stringify(item).replace(/'/g,"&#39;")}'
        style="${base}background:rgba(244,114,182,${inW?'0.15':'0.06'});border-color:rgba(244,114,182,${inW?'0.4':'0.2'});color:#f472b6;"
      >${inW?'❤️':'🤍'}</button>`;
  }

  /* Inject CSS once */
  (function(){
    if(document.getElementById('_smkStyle')) return;
    const s = document.createElement('style');
    s.id = '_smkStyle';
    s.textContent = `
      [data-cart-id]._smk-active{ background:rgba(113,255,0,0.18)!important; border-color:rgba(113,255,0,0.5)!important; }
      [data-wish-id]._smk-active{ background:rgba(244,114,182,0.18)!important; border-color:rgba(244,114,182,0.5)!important; }
    `;
    document.head.appendChild(s);
  })();

  _syncBadges();

  /* Canonical wishlist state changed — here, or on Product Detail, Category, Marketplace,
     or any other surface on the canonical path. Repaint every SokoniMarket button and
     badge on this page so the same product never reads two different ways. */
  window.addEventListener('sokoni:wishlist-changed', function(){
    try {
      _syncBadges();
      document.querySelectorAll('[data-wish-id]').forEach(function(btn){
        _refreshButtons(btn.getAttribute('data-wish-id'));
      });
    } catch (e) {}
  });

  return { addToCart, removeFromCart, addToWishlist, removeFromWishlist, toggleCart, toggleWishlist, isInCart, isInWishlist, btnHTML, _syncBadges };

})();
