/* NOTE: this file is currently DEAD CODE — no page loads it (it survives only in
   the service-worker precache list and in a couple of comments). It is escaped
   anyway so that wiring it up later cannot reintroduce the stored XSS that was
   found and fixed in wishlist.html's own renderer on 2026-07-24. */
function _wlEsc(str){
  return String(str == null ? '' : str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}
function _wlSafeImg(url){
  if(!url) return 'assets/default-product.png';
  const u = String(url);
  return (/^https?:\/\//i.test(u) || /^\/[^/]/.test(u) || !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(u))
    ? _wlEsc(u) : 'assets/default-product.png';
}

let wishlist = [];
try { wishlist = JSON.parse(localStorage.getItem("wishlist")) || []; }
catch(e) { wishlist = []; }

const wishlistContainer = document.getElementById("wishlistContainer");

function showNotif(msg, type){
    const c = document.getElementById("notificationContainer");
    if(!c) return;
    const n = document.createElement("div");
    n.className = `notification ${type}`;
    n.textContent = msg;
    c.appendChild(n);
    setTimeout(() => n.remove(), 3000);
}

function updateCount(list){
    const el = document.getElementById("wishCount");
    if(el) el.textContent = `${list.length} item${list.length !== 1 ? "s" : ""} saved`;
}

function renderWishlist(list){
    if(!wishlistContainer) return;
    updateCount(list);

    if(list.length === 0){
        wishlistContainer.innerHTML = `
            <div class="wish-empty-state">
                <div style="font-size:72px;margin-bottom:20px;">❤️</div>
                <h2>Your wishlist is empty</h2>
                <p>Save products you love to buy later</p>
                <a href="/" class="cart-shop-now-btn">Browse Products</a>
            </div>
        `;
        return;
    }

    wishlistContainer.innerHTML = list.map((p, i) => `
        <div class="wish-card">
            <div class="wish-card-img-wrap">
                <img src="${_wlSafeImg(p.image)}" alt="${_wlEsc(p.name)}">
                <button class="wish-remove-icon" onclick="removeWishlist(${wishlist.indexOf(p)})" title="Remove">✕</button>
            </div>
            <div class="wish-card-body">
                <h3>${_wlEsc(p.name)}</h3>
                <p class="wish-card-cat">${p.category ? _wlEsc(p.category.charAt(0).toUpperCase() + p.category.slice(1)) : 'Product'}</p>
                <p class="wish-card-price">KES ${Number(p.price).toLocaleString()}</p>
                <div class="wish-card-btns">
                    <button class="wish-add-cart-btn" onclick="moveToCart(${wishlist.indexOf(p)})">
                        🛒 Add to Cart
                    </button>
                    <button class="wish-buy-btn" onclick="buyNowWish(${wishlist.indexOf(p)})">
                        Buy Now
                    </button>
                </div>
            </div>
        </div>
    `).join("");
}

function removeWishlist(index){
    const item = wishlist[index];
    wishlist.splice(index, 1);
    localStorage.setItem("wishlist", JSON.stringify(wishlist));
    /* Decrement demand count */
    if(item){ adjustWishlistCount(item.id, -1); }
    showNotif("Removed from wishlist", "error");
    renderWishlist(wishlist);
}

function adjustWishlistCount(productId, delta){
    let prods = [];
    try { prods = JSON.parse(localStorage.getItem("sellerProducts"))||[]; } catch(e){}
    const idx = prods.findIndex(p => String(p.id) === String(productId));
    if(idx === -1) return;
    prods[idx].wishlistCount = Math.max(0, (Number(prods[idx].wishlistCount)||0) + delta);
    localStorage.setItem("sellerProducts", JSON.stringify(prods));
}

function moveToCart(index){
    const item = wishlist[index];
    let cart = JSON.parse(localStorage.getItem("cart") || "[]");
    cart.push(item);
    localStorage.setItem("cart", JSON.stringify(cart));
    wishlist.splice(index, 1);
    localStorage.setItem("wishlist", JSON.stringify(wishlist));
    showNotif("Moved to cart 🛒", "success");
    renderWishlist(wishlist);
}

function buyNowWish(index){
    const item = wishlist[index];
    let cart = JSON.parse(localStorage.getItem("cart") || "[]");
    cart.push(item);
    localStorage.setItem("cart", JSON.stringify(cart));
    window.location.href = "checkout.html";
}

function searchWishlist(){
    const val = document.getElementById("wishSearch").value.toLowerCase();
    const results = wishlist.filter(p => p.name.toLowerCase().includes(val));
    renderWishlist(results);
}

window.removeWishlist = removeWishlist;
window.moveToCart = moveToCart;
window.buyNowWish = buyNowWish;
window.searchWishlist = searchWishlist;

renderWishlist(wishlist);
