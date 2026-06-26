let cart = [];
try { cart = JSON.parse(localStorage.getItem("cart")) || []; }
catch(e) { cart = []; }

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
        </div>`).join('');

    const foodTotal = calcFoodTotal();
    return `
        <div class="cart-section-header">
          <span>🍔 Food Orders</span>
          <span>KES ${foodTotal.toLocaleString()}</span>
        </div>
        ${groups}
        <div class="cart-section-cta">
          <a href="food-order.html" class="cart-checkout-food">
            🍔 Checkout Food — KES ${foodTotal.toLocaleString()}
          </a>
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
        return `
        <div class="cart-page-card" id="cart-item-${idx}">
            <img src="${_safeImgSrc(p.image)}" alt="${_esc(p.name)}" class="cart-card-img">
            <div class="cart-card-info">
                <h3>${_esc(p.name)}</h3>
                <p class="cart-card-cat">${catDisplay}</p>
                <p class="cart-card-price">KES ${price.toLocaleString()}</p>
            </div>
            <div class="cart-card-actions">
                <button class="cart-move-wish" onclick="moveToWishlist(${idx})" title="Save for later">&#x2764;&#xFE0F;</button>
                <button class="cart-remove-btn" onclick="removeFromCart(${idx})">
                    <i class="fas fa-trash"></i> Remove
                </button>
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
                  <a href="index.html" class="cart-shop-now-btn">🛍️ Shop Products</a>
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
function removeFromCart(index){
    cart.splice(index, 1);
    localStorage.setItem("cart", JSON.stringify(cart));
    showNotif("Item removed from cart", "success");
    renderCart();
}

function removeFoodItem(cartId){
    const idx = cart.findIndex(i => i.cartId === cartId);
    if(idx !== -1) cart.splice(idx, 1);
    localStorage.setItem("cart", JSON.stringify(cart));
    showNotif("Item removed", "success");
    renderCart();
}

function foodQty(cartId, qty){
    if(qty <= 0){ removeFoodItem(cartId); return; }
    const item = cart.find(i => i.cartId === cartId);
    if(item){ item.qty = qty; }
    localStorage.setItem("cart", JSON.stringify(cart));
    renderCart();
}

function moveToWishlist(index){
    const item = cart[index];
    let wishlist = JSON.parse(localStorage.getItem("wishlist") || "[]");
    if(!wishlist.find(p => p.id === item.id)){
        wishlist.push(item);
        localStorage.setItem("wishlist", JSON.stringify(wishlist));
        showNotif("Moved to wishlist ❤️", "success");
    } else {
        showNotif("Already in wishlist", "success");
    }
    removeFromCart(index);
}

function clearCart(){
    if(cart.length === 0) return;
    cart = [];
    localStorage.setItem("cart", JSON.stringify(cart));
    showNotif("Cart cleared", "success");
    renderCart();
}

window.removeFromCart   = removeFromCart;
window.removeFoodItem   = removeFoodItem;
window.foodQty          = foodQty;
window.moveToWishlist   = moveToWishlist;
window.clearCart        = clearCart;

renderCart();
