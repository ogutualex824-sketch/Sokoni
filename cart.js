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

function calcTotal(){
    return cart.reduce((sum, p) => sum + Number(p.price || 0), 0);
}

function updateSummary(){
    const total = calcTotal();
    const s = document.getElementById("summarySubtotal");
    const t = document.getElementById("summaryTotal");
    if(s) s.textContent = `KES ${total.toLocaleString()}`;
    if(t) t.textContent = `KES ${total.toLocaleString()}`;
}

function renderCart(){
    if(!cartContainer) return;

    if(cart.length === 0){
        cartContainer.innerHTML = `
            <div class="cart-empty-state">
                <div style="font-size:72px;margin-bottom:20px;">🛒</div>
                <h2>Your cart is empty</h2>
                <p>Add some products to get started</p>
                <a href="index.html" class="cart-shop-now-btn">Start Shopping</a>
            </div>
        `;
        updateSummary();
        return;
    }

    cartContainer.innerHTML = cart.map((p, i) => {
        const idx = Number(i);
        const catRaw = String(p.category||'');
        const catDisplay = catRaw ? _esc(catRaw.charAt(0).toUpperCase() + catRaw.slice(1)) : 'Product';
        const price = Number(p.price)||0;
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
    }).join("");

    updateSummary();
}

function removeFromCart(index){
    cart.splice(index, 1);
    localStorage.setItem("cart", JSON.stringify(cart));
    showNotif("Item removed from cart", "success");
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

window.removeFromCart = removeFromCart;
window.moveToWishlist = moveToWishlist;
window.clearCart = clearCart;

renderCart();
