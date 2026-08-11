/* Read the cart without destroying it.

   This used to be `catch(e) { cart = [] }`. That looks harmless and is not:
   an unreadable cart rendered as empty, and the very next mutation — adding
   an item, changing a quantity — persisted that empty array over the real
   data. The customer's cart was silently deleted by the act of looking at it,
   with no message and nothing left to recover.

   Now the raw value is quarantined under its own key first, so support can
   restore it and so the bug leaves evidence instead of a shrug. A non-array
   is treated as corruption too: JSON.parse("5") succeeds and would otherwise
   hand every downstream .map/.reduce a number.

   That quarantine is NOT gone — it moved into SokoniCart, where every surface gets it
   instead of only this page. */

/* Canonical cart (Track 2.3.6). This page owned _readCart and _saveCartState: the last
   of the thirteen copies of that read/modify/write cycle, and the one the others were
   modelled on. SokoniCart owns the read, the write, the announcement and the quarantine.

   `cart` survives as a RENDER PROJECTION. _syncCart() refills it from the service at the
   top of renderCart(), so the totals, the food grouping and the row templates below need
   no change — and none of them can drift from what is stored. Nothing writes to it. */
function _cartSvc(){ return window.SokoniCart || null; }

let cart = [];

function _syncCart(){
  const c = _cartSvc();
  cart = c ? c.list() : [];
  return cart;
}
_syncCart();

const cartContainer = document.getElementById("cartContainer");

function _esc(str){
    return String(str==null?'':str)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}

function _safeImgSrc(url){
    if(!url) return 'assets/default-product.png';
    const u = String(url);
    return (/^https?:\/\//i.test(u) || /^\/[^/]/.test(u) || !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(u))
        ? _esc(u) : 'assets/default-product.png';
}

function showNotif(msg, type){
    const c = document.getElementById("notificationContainer");
    if(!c) return;
    const n = document.createElement("div");
    n.className = `notification ${type}`;
    n.textContent = msg;
    c.appendChild(n);
    setTimeout(() => n.remove(), 3000);
}

/* ── Totals ── */
function calcProductTotal(){
    return cart.filter(i => i.type !== 'food')
               .reduce((sum, p) => sum + Number(p.price || 0) * (p.qty || 1), 0);
}
function calcFoodTotal(){
    return cart.filter(i => i.type === 'food')
               .reduce((sum, p) => sum + Number(p.price || 0) * (p.qty || 1), 0);
}
function calcTotal(){
    return cart.reduce((sum, p) => sum + Number(p.price || 0) * (p.qty || 1), 0);
}

function updateSummary(){
    const total = calcTotal();
    const s = document.getElementById("summarySubtotal");
    const t = document.getElementById("summaryTotal");
    if(s) s.textContent = `KES ${total.toLocaleString()}`;
    if(t) t.textContent = `KES ${total.toLocaleString()}`;
}

/* ── Food section: grouped by restaurant ── */
function renderFoodSection(foodItems){
    if(!foodItems.length) return '';
    const vendors = {};
    foodItems.forEach(item => {
        if(!vendors[item.restaurantId]){
            vendors[item.restaurantId] = {
                name: item.restaurantName,
                emoji: item.restaurantEmoji || '🍽️',
                items: [], subtotal: 0,
            };
        }
        vendors[item.restaurantId].items.push(item);
        vendors[item.restaurantId].subtotal += Number(item.price||0) * (item.qty||1);
    });

    const groups = Object.entries(vendors).map(([rid, v]) => `
        <div class="cart-vendor-group">
          <div class="cart-vendor-header">
            <span class="cart-vendor-emoji">${_esc(v.emoji)}</span>
            <span class="cart-vendor-name">${_esc(v.name)}</span>
            <span class="cart-vendor-sub">KES ${v.subtotal.toLocaleString()}</span>
          </div>
          ${v.items.map(item => `
            <div class="cart-page-card cart-food-item" id="cart-food-${_esc(item.cartId)}">
              <div class="cart-food-info">
                <h3>${_esc(item.name)}</h3>
                <p class="cart-card-price">KES ${Number(item.price||0).toLocaleString()} × ${item.qty}</p>
                ${item.note ? `<p class="cart-card-cat">${_esc(item.note)}</p>` : ''}
              </div>
              <div class="cart-food-qty">
                <button class="cart-qty-btn" onclick="foodQty('${_esc(item.cartId)}',${(item.qty||1)-1})">−</button>
                <span class="cart-qty-num">${item.qty||1}</span>
                <button class="cart-qty-btn" onclick="foodQty('${_esc(item.cartId)}',${(item.qty||1)+1})">+</button>
              </div>
              <div class="cart-card-actions">
                <button class="cart-remove-btn" onclick="removeFoodItem('${_esc(item.cartId)}')">
                  <i class="fas fa-trash"></i> Remove
                </button>
              </div>
            </div>`).join('')}
          <div class="cart-vendor-cta">
            <a href="food-menu.html?id=${encodeURIComponent(rid)}" class="cart-checkout-food">
              🍔 Checkout ${_esc(v.name)} — KES ${v.subtotal.toLocaleString()}
            </a>
          </div>
        </div>`).join('');

    const foodTotal = calcFoodTotal();
    return `
        <div class="cart-section-header">
          <span>🍔 Food Orders</span>
          <span>KES ${foodTotal.toLocaleString()}</span>
        </div>
        ${groups}
        <div class="cart-section-cta">
          <a href="food-order.html" class="cart-track-orders">📋 Track my food orders</a>
        </div>`;
}

/* ── Products section ── */
function renderProductSection(productItems){
    if(!productItems.length) return '';
    const productTotal = calcProductTotal();
    const rows = productItems.map((p, i) => {
        const idx = cart.indexOf(p);
        const catRaw = String(p.category||'');
        const catDisplay = catRaw ? _esc(catRaw.charAt(0).toUpperCase() + catRaw.slice(1)) : 'Product';
        const price = Number(p.price||0);
        const qty = p.qty||1;
        return `
        <div class="cart-page-card" id="cart-item-${idx}">
            <img src="${_safeImgSrc(window.pickProductImage ? pickProductImage(p) : p.image)}" alt="${_esc(p.name)}" class="cart-card-img" onerror="this.onerror=null;this.src='assets/default-product.png'">
            <div class="cart-card-info">
                <h3>${_esc(p.name)}</h3>
                <p class="cart-card-cat">${catDisplay}</p>
                <p class="cart-card-price">KES ${(price*qty).toLocaleString()}</p>
            </div>
            <div class="cart-card-actions">
                <div class="cart-food-qty">
                    <button class="cart-qty-btn" onclick="productQty(${idx},${qty-1})">−</button>
                    <span class="cart-qty-num">${qty}</span>
                    <button class="cart-qty-btn" onclick="productQty(${idx},${qty+1})">+</button>
                </div>
                <button class="cart-move-wish" onclick="moveToWishlist(${idx})" title="Save for later">❤️</button>
                <button class="cart-remove-btn" onclick="removeFromCart(${idx})"><i class="fas fa-trash"></i> Remove</button>
            </div>
        </div>`;
    }).join('');

    return `
        <div class="cart-section-header">
          <span>🛒 Products</span>
          <span>KES ${productTotal.toLocaleString()}</span>
        </div>
        ${rows}
        <div class="cart-section-cta">
          <a href="checkout.html" class="cart-checkout-products">
            🛒 Checkout Products — KES ${productTotal.toLocaleString()}
          </a>
        </div>`;
}

/* ── Main render ── */
function renderCart(){
    /* Refill the projection from the authority BEFORE the early return, so what is drawn
       always matches what is stored — including changes made on another tab or by a
       surface that is not this page. */
    _syncCart();
    if(!cartContainer) return;

    const foodItems    = cart.filter(i => i.type === 'food');
    const productItems = cart.filter(i => i.type !== 'food');

    if(cart.length === 0){
        cartContainer.innerHTML = `
            <div class="cart-empty-state">
                <div style="font-size:72px;margin-bottom:20px;">🛒</div>
                <h2>Your cart is empty</h2>
                <p>Add products or food to get started</p>
                <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:16px;">
                  <a href="/" class="cart-shop-now-btn">🛍️ Shop Products</a>
                  <a href="food.html" class="cart-shop-now-btn" style="background:rgba(34,197,94,0.12);border-color:rgba(34,197,94,0.3);color:#22c55e;">🍔 Order Food</a>
                </div>
            </div>`;
        updateSummary();
        return;
    }

    cartContainer.innerHTML =
        renderFoodSection(foodItems) +
        renderProductSection(productItems);

    updateSummary();
}

/* ── Mutations ── */
/* removeAt, NOT removeAllById. This is the cart page's per-ROW delete: a shopper with
   three duplicate rows of one product who taps ✖ on one expects two to remain. The
   product-level removal (removeAllById) belongs to the marketplace card toggle, where
   "remove from cart" means the product is gone. Two different intents, two methods. */
function removeFromCart(index){
    const c = _cartSvc();
    if(!c){ showNotif("Cart is still loading — try again in a moment", "error"); return; }
    if(!c.removeAt(index)){ showNotif("Couldn't update your cart — please try again", "error"); return; }
    showNotif("Item removed from cart", "success");
    renderCart();
}

/* Food rows are keyed by cartId, not by product id: the same dish can appear twice with
   different notes and they are different lines. */
function removeFoodItem(cartId){
    const c = _cartSvc();
    if(!c){ showNotif("Cart is still loading — try again in a moment", "error"); return; }
    if(!c.removeByCartId(cartId)){ showNotif("Couldn't update your cart — please try again", "error"); return; }
    showNotif("Item removed", "success");
    renderCart();
}

/* qty <= 0 removing the row is EXISTING behaviour and is preserved — the service's
   setQty does the same thing, but the branch stays here so the correct toast still
   fires. */
function foodQty(cartId, qty){
    if(qty <= 0){ removeFoodItem(cartId); return; }
    const c = _cartSvc();
    if(!c){ showNotif("Cart is still loading — try again in a moment", "error"); return; }
    /* A string ref resolves cartId first, so a food line is matched by its own key. */
    if(!c.setQty(cartId, qty)){ showNotif("Couldn't update the quantity — please try again", "error"); return; }
    renderCart();
}

function productQty(index, qty){
    if(qty <= 0){ removeFromCart(index); return; }
    const c = _cartSvc();
    if(!c){ showNotif("Cart is still loading — try again in a moment", "error"); return; }
    /* A numeric ref is an array index — the rendered row order, which is the service's
       order, so duplicate rows stay individually adjustable. */
    if(!c.setQty(index, qty)){ showNotif("Couldn't update the quantity — please try again", "error"); return; }
    renderCart();
}

/* Canonical wishlist (wishlistItems/{uid}_{productId} via commerceDispatch). This wrote
   localStorage['wishlist'], which made "Moved to wishlist" a per-DEVICE claim the wishlist
   page could not honour once that page became canonical: the item left the cart and
   appeared nowhere.

   The order matters and was wrong before. "Move" is remove-after-add, never
   remove-and-hope: the cart line is only dropped once the canonical write has RESOLVED.
   With a localStorage write that distinction was invisible, because it cannot fail. With a
   server call it is the difference between moving an item and destroying it — a signed-out
   shopper, an offline moment or a permission error would previously have emptied the row
   and saved nothing. On failure the item stays in the cart and the toast says so. */
function moveToWishlist(index){
    const item = cart[index];
    if(!item) return Promise.resolve(false);
    const W = window.SokoniWishlist;
    if(!W){ showNotif("Wishlist is still loading", "error"); return Promise.resolve(false); }

    const pid = String(item.productId || item.id || "");
    if(!pid){ showNotif("This item can't be saved", "error"); return Promise.resolve(false); }

    /* Already saved is a success for the user's intent — the item IS in the wishlist — so
       the cart line still goes. Nothing is lost: canonical state already holds it. */
    if(W.isWishlisted(pid)){
        showNotif("Already in wishlist", "success");
        removeFromCart(index);
        return Promise.resolve(true);
    }

    return W.add({ productId: pid, shopId: item.shopId || null, name: item.name || "",
                   price: item.price != null ? item.price : null,
                   image: item.image || item.imageUrl || null })
      .then(() => {
          showNotif("Moved to wishlist ❤️", "success");
          /* Re-locate by identity rather than reusing `index`: the await gave other
             handlers a window to mutate the cart, and a stale index removes the wrong row. */
          const now = cart.indexOf(item);
          if(now !== -1) removeFromCart(now);
          return true;
      })
      .catch(e => {
          const msg = (e && e.message) || "";
          showNotif(/sign in/i.test(msg) ? "Sign in to save items"
                                         : "Couldn't save — item kept in your cart", "error");
          return false;
      });
}

function clearCart(){
    const c = _cartSvc();
    if(!c){ showNotif("Cart is still loading — try again in a moment", "error"); return; }
    if(c.lines() === 0) return;
    /* The one legitimate caller of clear(). checkout.html also clears the cart after an
       order, but that is part of the order lifecycle and stays on its own path until 2.4. */
    if(!c.clear()){ showNotif("Couldn't clear your cart — please try again", "error"); return; }
    showNotif("Cart cleared", "success");
    renderCart();
}

window.removeFromCart   = removeFromCart;
window.removeFoodItem   = removeFoodItem;
window.foodQty          = foodQty;
window.productQty       = productQty;
window.moveToWishlist   = moveToWishlist;
window.clearCart        = clearCart;

renderCart();
