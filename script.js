let db = null;
let collection = null;
let getDocs = null;

/* HTML-escapes the 5 dangerous characters for safe innerHTML / attribute insertion.
   Defined here so buildProductCard() and all callers share one implementation. */
const _escHtml = s => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

/* Block browser autofill/email injection on all search inputs sitewide */
(function blockSearchAutofill(){
  function applyToEl(el){
    if(el._autofillBlocked) return;
    el._autofillBlocked = true;
    el.setAttribute("autocomplete","off");
    el.setAttribute("autocorrect","off");
    el.setAttribute("autocapitalize","off");
    el.setAttribute("spellcheck","false");
    if(!el.name) el.name = "s_" + Math.random().toString(36).slice(2);
    /* readonly trick: browsers skip autofill on readonly inputs */
    el.setAttribute("readonly","readonly");
    el.addEventListener("focus", function(){ this.removeAttribute("readonly"); }, {once:false});
    el.addEventListener("blur",  function(){ this.setAttribute("readonly","readonly"); });
    /* Nuclear fallback: wipe any @ value that wasn't typed by user */
    el.addEventListener("focus", function(){
      if(this.value && this.value.indexOf("@") !== -1) this.value = "";
    });
    el.addEventListener("input", function(){
      this._typed = true;
    });
    el.addEventListener("change", function(){
      if(!this._typed && this.value && this.value.indexOf("@") !== -1) this.value = "";
    });
  }
  function scanAll(){
    document.querySelectorAll(
      'input[type="search"], input[type="text"][placeholder*="Search" i], input[type="text"][placeholder*="search" i]'
    ).forEach(applyToEl);
  }
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", function(){ scanAll(); setTimeout(scanAll, 1200); });
  } else {
    scanAll(); setTimeout(scanAll, 1200);
  }
})();

/* =========================
   FIREBASE SAFE LOAD
========================= */

(async () => {
  try {
    const firebaseModule = await import("./firebase.js");
    db = firebaseModule.db;
    const firestoreModule = await import(
      "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
    );
    collection = firestoreModule.collection;
    getDocs    = firestoreModule.getDocs;
  } catch(error) {
    console.warn("⚠ Firebase Failed — Using Local Products Only", error);
  }
})();

/* =========================
   NOTIFICATIONS
========================= */

/* ── Universal toast engine (works on every page, no container required) ── */
(function(){
  var _box = null;
  function _getBox(){
    if(_box && document.body.contains(_box)) return _box;
    _box = document.createElement('div');
    _box.id = '_skToastBox';
    _box.style.cssText = 'position:fixed;top:20px;right:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:320px;';
    document.body.appendChild(_box);
    if(!document.getElementById('_skToastCSS')){
      var s=document.createElement('style'); s.id='_skToastCSS';
      s.textContent='@keyframes _skIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}@keyframes _skOut{from{opacity:1;transform:translateX(0)}to{opacity:0;transform:translateX(20px)}}';
      document.head.appendChild(s);
    }
    return _box;
  }
  var BG={success:'#071d0b',error:'#1f0505',warning:'#1a1200',warn:'#1a1200',info:'#050f1a'};
  var BD={success:'#71ff00',error:'#ff4444',warning:'#ffaa00',warn:'#ffaa00',info:'#00d4ff'};
  var IC={success:'✅',error:'❌',warning:'⚠️',warn:'⚠️',info:'ℹ️'};
  function _dismiss(el){
    clearTimeout(el._tid);
    el.style.animation='_skOut .28s ease forwards';
    setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el);},270);
  }
  window._sokoniToast = function(msg, type, ms){
    type = type||'success'; ms = ms||3000;
    var el=document.createElement('div');
    el.style.cssText='background:'+(BG[type]||BG.success)+';border:1px solid '+(BD[type]||BD.success)+';border-radius:12px;padding:12px 16px;color:#fff;font-size:13px;font-family:inherit;font-weight:700;line-height:1.4;box-shadow:0 4px 24px rgba(0,0,0,0.55);animation:_skIn .3s ease;pointer-events:all;cursor:pointer;';
    el.innerHTML='<span style="margin-right:6px">'+(IC[type]||'📢')+'</span>'+String(msg).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    el.onclick=function(){_dismiss(el);};
    _getBox().appendChild(el);
    el._tid=setTimeout(function(){_dismiss(el);},ms);
  };
})();

function showNotification(message, type){
  /* Use existing container if page has one (cart, category, bnb pages) */
  var c=document.getElementById('notificationContainer');
  if(c){
    var n=document.createElement('div');
    n.classList.add('notification',type||'success');
    n.innerText=message;
    c.appendChild(n);
    setTimeout(function(){
      n.style.animation='notifOut .3s ease forwards';
      setTimeout(function(){if(n.parentNode)n.parentNode.removeChild(n);},280);
    },3000);
    return;
  }
  /* Universal fallback — works on any page */
  window._sokoniToast(message, type, 3000);
}
window.showNotification = showNotification;
window.showToast = function(msg, type){ window._sokoniToast(msg, type||'success', 3000); };

/* =========================
   CART
========================= */

let cart = JSON.parse(

    localStorage.getItem("cart")

) || [];

/* =========================
   WISHLIST
========================= */

let wishlist = JSON.parse(

    localStorage.getItem("wishlist")

) || [];

/* =========================
   PRODUCTS
========================= */

let products = [];

/* Hardcoded fallback — shown whenever localStorage has no products.
   Ensures the homepage always looks alive on first visit or cleared cache. */
const FALLBACK_PRODUCTS = [
  /* ── Electronics ── */
  { id:"F1",  name:"Samsung Galaxy A55 5G", price:52000, category:"electronics", location:"nairobi", sold:29, views:312, uploadedAt:Date.now()-2*86400000, outOfStock:false, sellerName:"Sokoni Electronics", image:"https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400&q=70", description:"128GB, 5G ready. Sealed in box with 1yr warranty.", wishlistCount:19 },
  { id:"F7",  name:"Bluetooth Gaming Headset", price:4500, category:"electronics", location:"nairobi", sold:37, views:223, uploadedAt:Date.now()-2*86400000, outOfStock:false, sellerName:"Game Zone KE", image:"https://images.unsplash.com/photo-1612198188060-c7c2a3b66eae?w=400&q=70", description:"Surround sound, noise-cancelling mic. PC/PS5/Xbox compatible.", wishlistCount:24 },
  { id:"F11", name:"Tecno Spark 20 Pro", price:22000, category:"electronics", location:"kisumu", sold:61, views:390, uploadedAt:Date.now()-2*86400000, outOfStock:false, sellerName:"Kisumu Tech Shop", image:"https://images.unsplash.com/photo-1592750475338-74b7b21085ab?w=400&q=70", description:"256GB, 8GB RAM. Massive battery. Sealed warranty.", wishlistCount:44 },
  { id:"F13", name:"Infinix Hot 40i", price:16500, category:"electronics", location:"nakuru", sold:47, views:280, uploadedAt:Date.now()-1*86400000, outOfStock:false, sellerName:"Nakuru Phones", image:"https://images.unsplash.com/photo-1580910051074-3eb694886505?w=400&q=70", description:"6.56\" screen, 5000mAh battery. Budget champion.", wishlistCount:31 },
  /* ── Fashion ── */
  { id:"F2",  name:"Vitenge Flare Dress", price:3200, category:"fashion", location:"nairobi", sold:45, views:201, uploadedAt:Date.now()-1*86400000, outOfStock:false, sellerName:"KenShop Fashion", image:"https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?w=400&q=70", description:"Premium kitenge fabric, custom sizes available.", wishlistCount:32 },
  { id:"F8",  name:"Men's Slim Fit Suit", price:7800, category:"fashion", location:"mombasa", sold:22, views:198, uploadedAt:Date.now()-6*86400000, outOfStock:false, sellerName:"Executive Wear Ke", image:"https://images.unsplash.com/photo-1507679799987-c73779587ccf?w=400&q=70", description:"Premium wool blend. Available in navy, black, charcoal.", wishlistCount:15 },
  { id:"F14", name:"Ankara Print Blazer", price:4500, category:"fashion", location:"nairobi", sold:33, views:167, uploadedAt:Date.now()-3*86400000, outOfStock:false, sellerName:"Afro Threads", image:"https://images.unsplash.com/photo-1594938298603-c8148c4b5571?w=400&q=70", description:"Bold Ankara print. Sizes XS-3XL. Statement piece.", wishlistCount:28 },
  /* ── Beauty ── */
  { id:"F3",  name:"Avocado Face Serum", price:850, category:"beauty", location:"nairobi", sold:82, views:445, uploadedAt:Date.now()-3*86400000, outOfStock:false, sellerName:"Beauty Kenya", image:"https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=400&q=70", description:"Natural Kenyan avocado extract. Brightens & hydrates.", wishlistCount:56 },
  { id:"F15", name:"Shea Butter Moisturiser 500ml", price:650, category:"beauty", location:"nairobi", sold:119, views:534, uploadedAt:Date.now()-1*86400000, outOfStock:false, sellerName:"Glow Naturals KE", image:"https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?w=400&q=70", description:"100% raw shea. No parabens. For all skin types.", wishlistCount:74 },
  /* ── Shoes ── */
  { id:"F4",  name:"Jordan 1 Retro High OG", price:14500, category:"shoes", location:"nairobi", sold:18, views:289, uploadedAt:Date.now()-4*86400000, outOfStock:false, sellerName:"Sneaker Hub KE", image:"https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400&q=70", description:"Original quality. Multiple sizes. Same day delivery Nairobi.", wishlistCount:41 },
  { id:"F16", name:"Ladies Block Heel Pump", price:3800, category:"shoes", location:"nairobi", sold:54, views:312, uploadedAt:Date.now()-2*86400000, outOfStock:false, sellerName:"Heels & More KE", image:"https://images.unsplash.com/photo-1543163521-1bf539c55dd2?w=400&q=70", description:"Comfortable 7cm block heel. Office & events. Sizes 36–42.", wishlistCount:49 },
  /* ── Food / Groceries ── */
  { id:"F6",  name:"Kenyan Arabica Coffee 1kg", price:1800, category:"food", location:"nairobi", sold:134, views:567, uploadedAt:Date.now()-1*86400000, outOfStock:false, sellerName:"Nyeri Highlands Coffee", image:"https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=400&q=70", description:"Single-origin Kenyan AA grade. Freshly roasted & vacuum sealed.", wishlistCount:88 },
  { id:"F17", name:"Organic Honey 1kg (Raw)", price:1200, category:"food", location:"nairobi", sold:201, views:789, uploadedAt:Date.now()-1*86400000, outOfStock:false, sellerName:"Baraka Apiaries", image:"https://images.unsplash.com/photo-1587049352846-4a222e784d38?w=400&q=70", description:"Wild forest honey. No additives. Harvested from Mt Kenya region.", wishlistCount:112 },
  /* ── Computers ── */
  { id:"F5",  name:"HP Pavilion 15 Laptop", price:68000, category:"computers", location:"nairobi", sold:11, views:178, uploadedAt:Date.now()-5*86400000, outOfStock:false, sellerName:"Tech World Kenya", image:"https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=400&q=70", description:"Intel Core i5, 16GB RAM, 512GB SSD. Perfect for students & professionals.", wishlistCount:28 },
  { id:"F18", name:"Dell Latitude 5540 (Refurb)", price:45000, category:"computers", location:"nairobi", sold:19, views:243, uploadedAt:Date.now()-3*86400000, outOfStock:false, sellerName:"ReNew Tech KE", image:"https://images.unsplash.com/photo-1588702547919-26089e690ecc?w=400&q=70", description:"Core i7, 16GB RAM, 512GB SSD. Grade A refurbished. 6-month warranty.", wishlistCount:22 },
  /* ── Appliances ── */
  { id:"F19", name:"Ramtons 7kg Top Load Washer", price:32000, category:"appliances", location:"nairobi", sold:14, views:189, uploadedAt:Date.now()-4*86400000, outOfStock:false, sellerName:"Ramtons Official KE", image:"https://images.unsplash.com/photo-1626806787461-102c1bfaaea1?w=400&q=70", description:"7kg capacity. 8 wash programs. Energy efficient. Free delivery Nairobi.", wishlistCount:18 },
  { id:"F20", name:"Mika 3-Burner Gas Cooker", price:12500, category:"appliances", location:"nairobi", sold:67, views:398, uploadedAt:Date.now()-2*86400000, outOfStock:false, sellerName:"Mika Appliances KE", image:"https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400&q=70", description:"Stainless steel. Cast iron grates. Auto ignition. Fits standard cylinders.", wishlistCount:43 },
  /* ── Sports ── */
  { id:"F9",  name:"Gym Protein Whey 2kg", price:6500, category:"sports", location:"nairobi", sold:54, views:312, uploadedAt:Date.now()-3*86400000, outOfStock:false, sellerName:"Fitness Pro Kenya", image:"https://images.unsplash.com/photo-1593095948071-474c5cc2989d?w=400&q=70", description:"24g protein per serving. Chocolate & vanilla. Free shaker.", wishlistCount:37 },
  { id:"F21", name:"Nike Dri-FIT Running Kit", price:5800, category:"sports", location:"nairobi", sold:38, views:267, uploadedAt:Date.now()-2*86400000, outOfStock:false, sellerName:"Sports Locker KE", image:"https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=400&q=70", description:"Breathable top + shorts set. Unisex. Sizes S–2XL.", wishlistCount:29 },
  /* ── Furniture ── */
  { id:"F10", name:"6-Seater Dining Table Set", price:42000, category:"furniture", location:"nairobi", sold:8, views:145, uploadedAt:Date.now()-7*86400000, outOfStock:false, sellerName:"Home Décor Kenya", image:"https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&q=70", description:"Solid mahogany. 6 chairs included. Delivery & assembly included.", wishlistCount:12 },
  { id:"F22", name:"3-Seater L-Shape Sofa", price:28000, category:"furniture", location:"nairobi", sold:16, views:201, uploadedAt:Date.now()-5*86400000, outOfStock:false, sellerName:"Comfort Interiors KE", image:"https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&q=70", description:"Premium fabric. Multiple colour options. Nairobi delivery included.", wishlistCount:34 },
  /* ── Printing ── */
  { id:"F23", name:"Business Cards (500 pcs) – Glossy", price:900, category:"printing", location:"nairobi", sold:287, views:1102, uploadedAt:Date.now()-1*86400000, outOfStock:false, sellerName:"Print Express Nairobi", image:"https://images.unsplash.com/photo-1572044162444-ad60f128bdea?w=400&q=70", description:"Full colour, glossy laminate. Same-day printing. Free design.", wishlistCount:63 },
  { id:"F24", name:"Large Format Banner 6×3ft", price:2400, category:"printing", location:"nairobi", sold:112, views:445, uploadedAt:Date.now()-2*86400000, outOfStock:false, sellerName:"SignIt Kenya", image:"https://images.unsplash.com/photo-1588345921523-c2dcdb7f1dcd?w=400&q=70", description:"UV-proof vinyl. Grommets included. Next-day delivery within Nairobi.", wishlistCount:27 },
  /* ── Accessories ── */
  { id:"F12", name:"Woven Kiondo Handbag", price:1200, category:"accessories", location:"nairobi", sold:93, views:521, uploadedAt:Date.now()-1*86400000, outOfStock:false, sellerName:"Maasai Crafts", image:"https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=400&q=70", description:"Handwoven by Kenyan artisans. Eco-friendly & unique.", wishlistCount:72 },
  { id:"F25", name:"Men's Leather Watch – Brown", price:4200, category:"accessories", location:"nairobi", sold:41, views:334, uploadedAt:Date.now()-3*86400000, outOfStock:false, sellerName:"TimeKeeper KE", image:"https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400&q=70", description:"Genuine leather strap. Quartz movement. Water resistant 30m.", wishlistCount:55 },
  /* ── Construction ── */
  { id:"F26", name:"40kg Portland Cement (per bag)", price:750, category:"construction", location:"nairobi", sold:512, views:1890, uploadedAt:Date.now()-1*86400000, outOfStock:false, sellerName:"BuildRight Supplies", image:"https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=400&q=70", description:"Bamburi Portland cement. Grade 42.5N. Bulk orders welcome. Nairobi delivery.", wishlistCount:38 },
  { id:"F27", name:"Iron Sheets – Gauge 30 (per pc)", price:1850, category:"construction", location:"nairobi", sold:234, views:876, uploadedAt:Date.now()-2*86400000, outOfStock:false, sellerName:"Mabati Kenya", image:"https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=400&q=70", description:"Gauge 30 galvanised. 2m, 2.5m, 3m lengths. Free delivery 10+ sheets.", wishlistCount:47 },

  { id:"G1", name:"6kg LPG Gas Cylinder (Full)", price:2800, category:"gas", location:"nairobi", sold:341, views:1204, uploadedAt:Date.now()-1*86400000, outOfStock:false, sellerName:"Total Energies KE", image:"https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=70", description:"6kg cooking gas cylinder. Full refill included. Free same-day delivery within Nairobi.", wishlistCount:78 },
  { id:"G2", name:"13kg LPG Gas Cylinder (Full)", price:5500, category:"gas", location:"nairobi", sold:198, views:876, uploadedAt:Date.now()-1*86400000, outOfStock:false, sellerName:"Pro Gas Kenya", image:"https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=70", description:"13kg cylinder. Ideal for home & restaurant use. Exchange or new cylinder available.", wishlistCount:52 },
  { id:"G3", name:"Gas Regulator + Pipe Set", price:650, category:"gas", location:"nairobi", sold:421, views:1560, uploadedAt:Date.now()-2*86400000, outOfStock:false, sellerName:"Gas Centre KE", image:"https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=70", description:"High-pressure regulator + 1.5m reinforced pipe. Fits all 6kg & 13kg cylinders.", wishlistCount:109 },
];

/* =========================
   LOAD PRODUCTS
========================= */

/* ── Phase 8: skeleton placeholder shown immediately so grid has height
   before products arrive from localStorage. Prevents CLS jump. ── */
function _p8ShowSkeletons(container, count) {
    const sk = '<div class="p8-sk"><div class="p8-sk-img"></div><div class="p8-sk-line w85"></div><div class="p8-sk-line w45"></div><div class="p8-sk-line w70"></div></div>';
    container.innerHTML = Array(count).fill(sk).join('');
}

function loadProducts(){

    const container =
    document.getElementById(
        "productsContainer"
    );

    if(!container){
        return;
    }

    /* Show skeletons immediately — keeps the grid area occupied (CLS protection)
       and signals to the user that content is coming */
    _p8ShowSkeletons(container, 8);

    /* GET PRODUCTS */

    let savedProducts;
    try {
        savedProducts = JSON.parse(localStorage.getItem("sellerProducts")) || [];
    } catch(e) {
        localStorage.removeItem("sellerProducts");
        savedProducts = [];
    }


    /* SORT: boosted products first */
    let ads = [];
    try { ads = JSON.parse(localStorage.getItem("sokoniAds")) || []; } catch(e) {}
    const activeBoostedIds = ads.filter(a => a.endsAt > Date.now()).map(a => a.productId);

    savedProducts.sort((a,b) => {
        const aB = activeBoostedIds.includes(a.id) ? 1 : 0;
        const bB = activeBoostedIds.includes(b.id) ? 1 : 0;
        return bB - aB;
    });

    /* Use fallback products when localStorage is empty so page always looks alive */
    products = savedProducts.length > 0 ? savedProducts : FALLBACK_PRODUCTS;

    /* EMPTY */

    if(products.length === 0){

        container.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:60px 20px;">
            <div style="font-size:56px;margin-bottom:16px;">🛍️</div>
            <h2 style="color:white;font-size:22px;margin-bottom:10px;">No products yet</h2>
            <p style="color:rgba(255,255,255,0.4);margin-bottom:22px;">Be the first to sell on Sokoni!</p>
            <a href="seller.html" style="padding:13px 28px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;border-radius:14px;text-decoration:none;font-weight:800;">Start Selling →</a>
        </div>
        `;

        return;
    }

    /* Update trending count badge */
    const trendCountEl = document.getElementById("pTrendCount");
    if(trendCountEl) trendCountEl.textContent = products.length + "+ products";

    /* DISPLAY — home page shows up to 20 trending cards */
    displayProducts(products.slice(0, 20));
    displayNewArrivals();
    displayRecommendedProducts();
    displayFeaturedShops();
    startLivePopup();
    initNearbyLocation();

    /* SPOTLIGHT — auto-rotate products, sellers & stories */
    if(typeof window.SokoniSpotlight !== 'undefined') {
      window.SokoniSpotlight.init(products);
    } else {
      document.addEventListener('sokoni-spotlight-ready', function() {
        window.SokoniSpotlight.init(products);
      }, { once: true });
    }

    /* Restore scroll position if coming back to this page */
    restoreHomeScroll();

}

/* =========================
   PRODUCT CARD BUILDER
========================= */

function isProductBoosted(productId){
    let ads = [];
    try { ads = JSON.parse(localStorage.getItem("sokoniAds")) || []; } catch(e) {}
    return ads.some(a => a.productId === productId && a.endsAt > Date.now());
}

function productBadge(product){
    if(isProductBoosted(product.id)) return `<div class="prod-badge badge-sponsored">📢 Sponsored</div>`;
    if(product.isDigital)            return `<div class="prod-badge badge-digital">💻 Digital</div>`;
    const ageMs = Date.now() - Number(product.uploadedAt || product.id);
    if(ageMs < 86400000 * 3)        return `<div class="prod-badge badge-new">NEW</div>`;
    if((product.views || 0) >= 5)   return `<div class="prod-badge badge-hot">HOT 🔥</div>`;
    return "";
}

const locationLabels = { nairobi:"Nairobi", mombasa:"Mombasa", kisumu:"Kisumu", nakuru:"Nakuru", eldoret:"Eldoret", thika:"Thika", kenya:"🌍 All Kenya", remote:"💻 Remote", worldwide:"🌐 Worldwide" };

/* ================================================
   NEARBY SELLERS — Geolocation Engine
================================================ */

const KENYA_CITIES = {
    nairobi: { lat:-1.286, lng:36.817, name:"Nairobi",   radius:40 },
    mombasa: { lat:-4.042, lng:39.666, name:"Mombasa",   radius:30 },
    kisumu:  { lat:-0.102, lng:34.761, name:"Kisumu",    radius:25 },
    nakuru:  { lat:-0.303, lng:36.080, name:"Nakuru",    radius:30 },
    eldoret: { lat: 0.521, lng:35.270, name:"Eldoret",   radius:25 },
    thika:   { lat:-1.033, lng:37.067, name:"Thika",     radius:20 }
};

let buyerLocation = null;   /* { lat, lng } */
let buyerCity     = null;   /* e.g. "nairobi" */

function haversineKm(lat1, lng1, lat2, lng2){
    const R = 6371;
    const dLat = (lat2-lat1)*Math.PI/180;
    const dLng = (lng2-lng1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function detectBuyerCity(lat, lng){
    let nearest = null, minDist = Infinity;
    Object.entries(KENYA_CITIES).forEach(([key, city]) => {
        const d = haversineKm(lat, lng, city.lat, city.lng);
        if(d < minDist){ minDist = d; nearest = key; }
    });
    return { city: nearest, distKm: Math.round(minDist) };
}

function distanceToCityCenter(productLocation){
    if(!buyerLocation || !productLocation) return null;
    const city = KENYA_CITIES[productLocation];
    if(!city) return null;
    return Math.round(haversineKm(buyerLocation.lat, buyerLocation.lng, city.lat, city.lng));
}

function distanceBadge(product){
    const km = distanceToCityCenter(product.location);
    if(km === null) return "";
    if(km <= 5)  return `<div class="distance-badge dist-near">📍 ${km} km away</div>`;
    if(km <= 30) return `<div class="distance-badge dist-mid">📍 ${km} km</div>`;
    return `<div class="distance-badge dist-far">📍 ${km} km</div>`;
}

/* Request geolocation on load */
function initNearbyLocation(){
    if(!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(pos => {
        buyerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const { city, distKm } = detectBuyerCity(buyerLocation.lat, buyerLocation.lng);
        buyerCity = city;
        localStorage.setItem("sokoniBuyerCity", city);
        displayNearbySection();
        displayProducts(products.slice(0, 8)); // re-render with distance badges
    }, () => {
        /* Use saved city if any */
        const saved = localStorage.getItem("sokoniBuyerCity");
        if(saved){ buyerCity = saved; displayNearbySection(); }
    });
}

function displayNearbySection(){
    const section = document.getElementById("nearbySection");
    if(!section || !buyerCity || !products.length) return;

    const nearby = products.filter(p => p.location === buyerCity || p.location === "worldwide");
    if(!nearby.length){ section.style.display="none"; return; }

    const cityName = KENYA_CITIES[buyerCity]?.name || buyerCity;
    section.style.display = "block";

    const titleEl = document.getElementById("nearbySectionTitle");
    if(titleEl) titleEl.textContent = `📍 Sellers Near You in ${cityName}`;

    /* Group products by seller */
    const sellerMap = {};
    nearby.forEach(p => {
        const key = p.sellerName || "Sokoni Seller";
        if(!sellerMap[key]) sellerMap[key] = { name: key, location: p.location, products: [] };
        sellerMap[key].products.push(p);
    });

    let allRatings = {};
    try { allRatings = JSON.parse(localStorage.getItem("sokoniSellerRatings"))||{}; } catch(e){}

    let orders = [];
    try { orders = JSON.parse(localStorage.getItem("sokoniOrders"))||[]; } catch(e){}

    const CAT_LABELS = { fashion:"👕 Fashion", electronics:"📱 Electronics", furniture:"🛋️ Furniture", beauty:"💄 Beauty", food:"🍎 Food", shoes:"👟 Shoes", bags:"👜 Bags", books:"📚 Books", appliances:"🏠 Appliances", cars:"🚗 Cars", sports:"⚽ Sports", printing:"🖨️ Printing" };

    const grid = document.getElementById("nearbyGrid");
    if(!grid) return;

    const sellers = Object.values(sellerMap).slice(0, 20);
    grid.innerHTML = sellers.map(s => {
        const ratings  = allRatings[s.name] || [];
        const avgRating = ratings.length ? (ratings.reduce((sum,r) => sum + r.stars, 0) / ratings.length).toFixed(1) : null;
        const starsHtml = avgRating
            ? `<span style="color:#ffc107;">${"★".repeat(Math.round(avgRating))}${"☆".repeat(5 - Math.round(avgRating))}</span>`
            : `<span style="color:rgba(255,255,255,0.25);">☆☆☆☆☆</span>`;
        const ratingText = avgRating
            ? `${avgRating} · ${ratings.length} review${ratings.length !== 1 ? "s" : ""}`
            : "New Seller";

        let totalSales = 0;
        orders.forEach(o => {
            if(o.status === "delivered"){
                (o.items || []).forEach(item => {
                    if(s.products.find(p => p.id === item.id)) totalSales++;
                });
            }
        });

        const locationName = KENYA_CITIES[s.location]?.name || s.location || "Kenya";
        const initials = s.name.split(" ").map(w => w[0]).join("").substring(0, 2).toUpperCase();
        const tags = [...new Set(s.products.map(p => p.category))].slice(0, 2);
        const profileUrl = `seller-public.html?seller=${encodeURIComponent(s.name)}`;

        return `<div class="seller-card" style="cursor:pointer;" onclick="window.location.href='${profileUrl}'">
            <div class="seller-avatar" style="background:linear-gradient(135deg,rgba(113,255,0,0.15),rgba(0,170,255,0.15));display:flex;align-items:center;justify-content:center;width:72px;height:72px;border-radius:50%;border:2px solid rgba(113,255,0,0.3);">
                <span style="font-size:22px;font-weight:900;color:#71ff00;">${initials}</span>
            </div>
            <h3>${s.name}</h3>
            <div class="seller-location-tag">📍 ${locationName}</div>
            <div class="seller-stars">${starsHtml}</div>
            <p class="seller-rating-text">${ratingText}${totalSales > 0 ? " · " + totalSales + " Sales" : ""}</p>
            <div class="seller-tags">
                ${tags.map(t => `<span class="seller-tag">${CAT_LABELS[t] || "🛍️ " + t}</span>`).join("")}
                <span class="seller-tag">📦 ${s.products.length} listing${s.products.length !== 1 ? "s" : ""}</span>
            </div>
            <a href="${profileUrl}" class="seller-visit-btn" onclick="event.stopPropagation()">
                <i class="fas fa-store"></i> View Seller
            </a>
        </div>`;
    }).join("");
}

window.initNearbyLocation = initNearbyLocation;

/* ── Delivery location picker — triggered by nav location pill ── */
function pickDeliveryLocation(){
    const cities = [
        {key:"nairobi", label:"📍 Nairobi"},
        {key:"mombasa", label:"📍 Mombasa"},
        {key:"kisumu",  label:"📍 Kisumu"},
        {key:"nakuru",  label:"📍 Nakuru"},
        {key:"eldoret", label:"📍 Eldoret"},
        {key:"thika",   label:"📍 Thika"},
        {key:"kenya",   label:"🌍 All Kenya"},
    ];
    const existing = document.getElementById("_locPickerModal");
    if(existing){ existing.remove(); return; }

    const current = localStorage.getItem("sokoniBuyerCity") || "nairobi";
    const overlay = document.createElement("div");
    overlay.id = "_locPickerModal";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:99990;display:flex;align-items:flex-end;justify-content:center;backdrop-filter:blur(4px);";
    overlay.onclick = function(e){ if(e.target===overlay) overlay.remove(); };

    const sheet = document.createElement("div");
    sheet.style.cssText = "background:#111;border-radius:24px 24px 0 0;padding:20px 20px 32px;width:100%;max-width:460px;border-top:1px solid rgba(113,255,0,0.15);";
    sheet.innerHTML = "<div style='font-size:14px;font-weight:900;color:white;margin-bottom:16px;text-align:center;'>📍 Choose Delivery Location</div>" +
        cities.map(c=>`<button type="button" onclick="window._setDeliveryCity('${c.key}', this.closest('#_locPickerModal'))" style="display:block;width:100%;padding:12px 16px;margin-bottom:8px;background:${c.key===current?'rgba(113,255,0,0.12)':'rgba(255,255,255,0.04)'};border:1px solid ${c.key===current?'rgba(113,255,0,0.35)':'rgba(255,255,255,0.08)'};border-radius:12px;color:${c.key===current?'#71ff00':'white'};font-size:14px;font-weight:700;cursor:pointer;text-align:left;font-family:inherit;">${c.label}${c.key===current?' ✓':''}</button>`).join("");
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
}

window._setDeliveryCity = function(city, modal){
    localStorage.setItem("sokoniBuyerCity", city);
    buyerCity = city;
    const labels = {nairobi:"Nairobi",mombasa:"Mombasa",kisumu:"Kisumu",nakuru:"Nakuru",eldoret:"Eldoret",thika:"Thika",kenya:"All Kenya"};
    const el = document.getElementById("navLocText");
    if(el) el.textContent = labels[city] || "Kenya";
    if(modal) modal.remove();
    displayNearbySection();
    displayProducts(products.slice(0, 20));
};
if (!window.pickDeliveryLocation) window.pickDeliveryLocation = pickDeliveryLocation;

const KEBS_REQUIRED_CATS = new Set(["food","agriculture","livestock","electronics","computers","cameras","appliances","gaming","health","beauty","skincare","haircare","fragrances","toys","kids","tyres","auto-parts"]);

/* ----- VERIFIED SELLER BADGE ----- */
function isSellerVerified(){
  const v = JSON.parse(localStorage.getItem("sokoniSellerVerification")||"null");
  return v && v.status === "verified";
}

/* ----- SELLER AGGREGATE RATING ----- */
function getSellerRating(sellerName){
  if(!sellerName) return null;
  let all = {};
  try { all = JSON.parse(localStorage.getItem("sokoniSellerRatings"))||{}; } catch(e){}
  const arr = all[sellerName] || [];
  if(!arr.length) return null;
  return (arr.reduce((s,r)=>s+r.stars,0)/arr.length).toFixed(1);
}

/* ----- STAR RATINGS HELPER ----- */
function getProductRating(productId){
  let ratings = {};
  try { ratings = JSON.parse(localStorage.getItem("sokoniRatings"))||{}; } catch(e){}
  const arr = ratings[productId] || [];
  if(!arr.length) return null;
  const avg = arr.reduce((s,r)=>s+r.stars,0) / arr.length;
  return { avg: Math.round(avg*10)/10, count: arr.length };
}

function ratingStarsHtml(avg){
  const full  = Math.floor(avg);
  const half  = avg - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return "★".repeat(full) + (half?"½":"") + "☆".repeat(empty);
}

/* ----- PRICE HISTORY BADGE ----- */
function priceChangeBadge(product){
    if(!product.priceHistory || !product.priceHistory.length) return "";
    const last = product.priceHistory[0];
    const daysSince = (Date.now() - last.timestamp) / 86400000;
    if(daysSince > 14) return "";
    const diff = product.price - last.price;
    if(diff === 0) return "";
    const pct  = Math.abs(Math.round((diff / last.price) * 100));
    const up   = diff > 0;
    return `<div class="price-change-badge ${up ? "price-up" : "price-down"}">${up ? "▲" : "▼"} ${pct}% ${up ? "higher" : "lower"}</div>`;
}

/* ----- WISHLIST DEMAND BADGE ----- */
function wishlistDemandBadge(product){
    const count = Number(product.wishlistCount || 0);
    if(count < 1) return "";
    const hot = count >= 10;
    return `<div class="wishlist-demand-badge ${hot ? "demand-hot" : ""}">❤️ ${count} want${count>1?"s":""} this</div>`;
}

function kebsBadge(product){
    if(product.kebsCert){
        return `<div class="kebs-badge kebs-certified" title="KEBS Certified: ${product.kebsCert}">🏅 KEBS</div>`;
    }
    if(KEBS_REQUIRED_CATS.has(product.category)){
        return `<div class="kebs-badge kebs-unverified" title="KEBS certification not provided">⚠️ No KEBS</div>`;
    }
    return "";
}

function buildProductCard(product, size = "normal"){
    const safeId   = String(product.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const badge    = productBadge(product);
    const kebs     = kebsBadge(product);
    const img      = product.image || "assets/default-product.png";
    const price    = Number(product.price).toLocaleString();
    const locLabel = product.location ? locationLabels[product.location] || product.location : "";
    const locTag   = locLabel ? `<span class="product-location-tag">📍 ${locLabel}</span>` : "";
    const descTag  = product.description ? `<p class="product-desc-text">${_escHtml(product.description)}</p>` : "";
    const boosted  = isProductBoosted(product.id);
    const isAdult     = typeof isAdultCategory === "function" && isAdultCategory(product.category);
    const adultBadge  = isAdult ? `<div class="adult-card-badge">🔞 18+</div>` : "";
    const oos         = product.outOfStock || (product.stock !== undefined && Number(product.stock) === 0);
    const oosOverlay  = oos ? `<div class="oos-overlay">Out of Stock</div>` : "";
    const btnDisabled = oos ? "disabled" : "";
    const priceBadge    = priceChangeBadge(product);
    const demandBadge   = wishlistDemandBadge(product);
    const distBadge     = distanceBadge(product);
    const rating        = getProductRating(product.id);
    const ratingHtml    = rating ? `<div class="product-rating-row"><span class="product-stars">${ratingStarsHtml(rating.avg)}</span><span class="product-rating-count">${rating.avg} (${rating.count})</span></div>` : "";
    const _srn = product.sellerName || '';
    const _sri = _srn ? _srn.split(' ').map(w=>w[0]||'').join('').substring(0,2).toUpperCase() : '';
    const _src = _srn ? ['#6366f1','#f59e0b','#10b981','#e11d48','#a8ff58','#0891b2','#dc2626','#059669'][_srn.split('').reduce((a,c)=>a+c.charCodeAt(0),0)%8] : '';
    /* data-stop-prop prevents the card's open-product handler from firing when clicking the seller ring */
    const shopRing = _srn ? `<a class="pcard-shop-ring" href="seller-public.html?seller=${encodeURIComponent(_srn)}" data-stop-prop="1" title="Visit ${_escHtml(_srn)}" style="background:${_src};">${_escHtml(_sri)}</a>` : '';
    const verified        = product.sellerName && isSellerVerified();
    const sellerAvgRating = getSellerRating(product.sellerName);
    const verifiedBadge   = verified
      ? `<div class="seller-verified-badge" title="Verified Seller">✅ Verified${sellerAvgRating ? " · ⭐"+sellerAvgRating : ""}</div>`
      : (sellerAvgRating ? `<div class="seller-verified-badge" style="color:rgba(255,193,7,0.9);background:rgba(255,193,7,0.08);border-color:rgba(255,193,7,0.2);">⭐ ${sellerAvgRating} seller rating</div>` : "");
    const wholesaleBadge  = product.wholesalePrice && product.minWholesaleQty
      ? `<div style="font-size:10px;font-weight:800;background:rgba(0,170,255,0.1);border:1px solid rgba(0,170,255,0.2);color:#00aaff;padding:3px 8px;border-radius:6px;display:inline-block;margin-bottom:6px;">🏷️ Bulk: KES ${Number(product.wholesalePrice).toLocaleString()} / min ${product.minWholesaleQty}</div>`
      : "";
    const ownerVerifiedBadge = product.verificationStatus === "approved"
      ? `<div style="font-size:10px;font-weight:800;background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.22);color:#71ff00;padding:3px 8px;border-radius:6px;display:inline-block;margin-bottom:4px;">✅ Verified Owner</div>`
      : product.verificationStatus === "pending"
      ? `<div style="font-size:10px;font-weight:700;background:rgba(255,152,0,0.08);border:1px solid rgba(255,152,0,0.2);color:#ff9800;padding:3px 8px;border-radius:6px;display:inline-block;margin-bottom:4px;">🔍 Ownership Review</div>`
      : "";
    const compact    = (size === "compact");
    const _mkSafeId  = id => String(id||'').replace(/[^a-zA-Z0-9_-]/g,'');
    const inWishlist = Array.isArray(wishlist) && wishlist.some(w => _mkSafeId(w.id) === safeId);
    const stockNum   = Number(product.stock);
    const stockChip  = !oos && product.stock !== undefined && stockNum > 0 && stockNum <= 5
        ? `<span class="pcard-stock pcard-stock--low">⚡ Only ${stockNum} left</span>`
        : '';
    const SVC_CATS = new Set(["phone-repair","computer-repair","electronics-repair","graphic-design","photography","videography","music-audio","cleaning","laundry","gardening","plumbing","electrical","interior-design","delivery-service","courier","boda-delivery","marketing","accounting","legal","virtual-assistant","printing","tutoring","coaching","events","catering","hair-beauty","fitness","services"]);
    const DIG_CATS = new Set(["ebook","template","course","software","license"]);
    const isServiceProd = SVC_CATS.has(product.category) || product.isService;
    const isDigitalProd = DIG_CATS.has(product.category) || product.isDigital;
    const buyLabel = isServiceProd ? "📩 Book" : isDigitalProd ? "⚡ Get" : "Buy Now";
    const cartLabel = isServiceProd ? "📋 Enquire" : isDigitalProd ? "🛒 Buy" : "🛒 Cart";

    /* ── All user-data goes into data-* attributes; zero inline JS injection. ──
       A single delegated listener on productsContainer handles all interactions.
       data-name stores the HTML-escaped product name; dataset.name returns the
       decoded raw value, which the handler then passes to functions. ── */
    const dName  = _escHtml(product.name);
    const dPrice = Number(product.price) || 0;

    const btnRow = compact
        ? `<div class="pcard-actions pcard-actions--compact">
                <div class="pcard-row">
                    <button class="pcard-btn pcard-btn--cart" data-action="cart" ${btnDisabled}>
                        ${isServiceProd ? "📩" : "🛒"} <span>${isServiceProd ? "Book" : "Cart"}</span>
                    </button>
                    <button class="pcard-btn pcard-btn--wish${inWishlist?' pcard-btn--wish-active':''}" data-action="wish" title="${inWishlist?'Saved':'Wishlist'}">
                        ❤
                    </button>
                    <button class="pcard-btn pcard-btn--buy" data-action="buy" ${btnDisabled}>
                        ${isServiceProd ? "📋" : "⚡"} <span>${isServiceProd ? "Hire" : "Buy"}</span>
                    </button>
                </div>
           </div>`
        : `<div class="pcard-actions">
                <div class="pcard-row">
                    <button class="pcard-btn pcard-btn--cart" data-action="cart" ${btnDisabled}>
                        ${isServiceProd ? "📩" : "🛒"} ${cartLabel.replace(/^[^\s]+ /,"")}
                    </button>
                    <button class="pcard-btn pcard-btn--wish${inWishlist?' pcard-btn--wish-active':''}" data-action="wish" title="${inWishlist?'Saved':'Wishlist'}">❤</button>
                    <button class="pcard-btn pcard-btn--buy" data-action="buy" ${btnDisabled}>
                        ${buyLabel}
                    </button>
                </div>
                <div class="pcard-row pcard-row--secondary">
                    <button class="pcard-btn pcard-btn--share" data-action="share"
                            data-name="${dName}" data-price="${dPrice}">
                        <i class="fab fa-whatsapp"></i> Share
                    </button>
                    <button class="pcard-btn pcard-btn--offer" data-action="offer"
                            data-name="${dName}" data-price="${dPrice}">
                        ${isServiceProd ? "💬 Chat" : "🏷️ Offer"}
                    </button>
                </div>
           </div>`;

    const catEmoji = {electronics:'📱',fashion:'👗',beauty:'💄',shoes:'👟',food:'🛒',computers:'💻',appliances:'🔌',sports:'⚽',furniture:'🛋️',accessories:'👜',construction:'🏗️',printing:'🖨️',services:'🛠️',gas:'🔥',charcoal:'🪵',solar:'☀️'};
    const catLabel = product.category ? (product.category.charAt(0).toUpperCase()+product.category.slice(1).replace(/-/g,' ')) : 'Shop';

    const nameOverlay = `<div class="pcard-name-overlay">
        <span class="pcard-ov-cat">${catEmoji[product.category]||'🛍️'} ${_escHtml(catLabel)}</span>
        <span class="pcard-ov-name">${_escHtml(product.name)}</span>
        <div class="pcard-ov-bottom">
            <span class="pcard-ov-price">KES ${price}</span>
            ${rating ? `<span class="pcard-ov-stars">${ratingStarsHtml(rating.avg)} <span class="pcard-ov-rcount">${rating.count}</span></span>` : ''}
        </div>
    </div>`;

    const _soldCnt  = Number(product.soldCount  || 0);
    const _wishCnt  = Number(product.wishlistCount || 0);
    const _stripInfo = _soldCnt > 5  ? `✅ ${_soldCnt.toLocaleString()} sold` :
                       _wishCnt >= 5 ? `🔥 ${_wishCnt} want this` :
                       product.sellerName ? `🏪 ${_escHtml(product.sellerName.split(' ')[0])}` : '📦 In stock';

    /* data-stop-prop on the strip prevents accidental card-open on strip touch/scroll */
    const mobileStrip = `<div class="pcard-mobile-strip" data-stop-prop="1">
        <div class="pcard-m-top-row">
            <span class="pcard-strip-info">${_stripInfo}</span>${stockChip}
        </div>
        <div class="pcard-m-btns">
            <button class="pcard-m-wish${inWishlist?' pcard-m-wish--active':''}" data-action="wish" title="${inWishlist?'Saved':'Wishlist'}">❤</button>
            <button class="pcard-m-cart" data-action="cart" ${btnDisabled}>${isServiceProd?'📩':'🛒'}</button>
            <button class="pcard-m-buy" data-action="buy" ${btnDisabled}>${isServiceProd?'Book':'⚡ Buy'}</button>
        </div>
    </div>`;

    /* data-pid is the single source of truth for which product this card represents */
    return `
        <div class="product-card ${boosted ? "product-boosted" : ""} ${isAdult ? "adult-card" : ""} ${oos ? "oos-card" : ""}" style="position:relative;animation:cardFadeIn 0.35s ease;" data-pid="${safeId}">
            ${adultBadge}
            ${oosOverlay}
            <div class="product-img-wrap" data-emoji="${catEmoji[product.category]||'🛍️'}">
                <img src="${img}" alt="${_escHtml(product.name)}" loading="lazy" decoding="async"
                  onerror="this.style.display='none';this.parentNode.classList.add('img-failed')">
                ${locTag}
                ${nameOverlay}
                ${shopRing}
            </div>
            <div class="product-body">
                ${badge || kebs ? `<div class="pcard-badge-row">${badge}${kebs}</div>` : ""}
                <h3 class="product-name">${_escHtml(product.name)}</h3>
                ${getSellerBadgesHtml(product.sellerName,'sm')}
                <div class="price-row">
                    <p class="price">KES ${price}</p>
                    ${priceBadge}
                </div>
                ${rating ? `<div class="rating-stars" style="font-size:9px;color:rgba(255,193,7,0.8);font-weight:700;margin-top:2px;">${ratingStarsHtml(rating.avg)} <span style="color:rgba(255,255,255,0.35);font-size:8px;">(${rating.count})</span></div>` : ""}
            </div>
            ${btnRow}
            ${mobileStrip}
        </div>
    `;
}

/* ── Delegated product-card click handler ───────────────────────────────────
   A single listener on productsContainer handles all card interactions.
   No inline JS, no user-data in event attribute strings.
─────────────────────────────────────────────────────────────────────────── */
function _productCardClick(e) {
    /* Action buttons (cart, wish, buy, share, offer) take priority */
    const btn = e.target.closest('[data-action]');
    if (btn) {
        e.stopPropagation();
        if (btn.disabled || btn.dataset.loading === '1') return;
        const card = btn.closest('[data-pid]');
        const pid  = card ? card.dataset.pid : null;
        if (!pid) return;
        const action = btn.dataset.action;
        /* dataset.name gives the HTML-decoded raw value (browser unescapes &amp; etc.) */
        const rawName = btn.dataset.name || '';
        const price   = btn.dataset.price || '0';
        if (action === 'cart')  { buyProduct(pid, btn); return; }
        if (action === 'wish')  { addToWishlist(pid); return; }
        if (action === 'buy')   { buyNow(pid, btn); return; }
        if (action === 'share') { shareProductWA(encodeURIComponent(rawName), price); return; }
        if (action === 'offer') { quickOffer(pid, encodeURIComponent(rawName), price); return; }
        return;
    }
    /* Propagation guards (seller ring anchor, mobile strip) — stop without opening */
    if (e.target.closest('[data-stop-prop]')) {
        e.stopPropagation();
        return;
    }
    /* Default: open the product whose card was clicked */
    const card = e.target.closest('[data-pid]');
    if (card) openProduct(card.dataset.pid);
}

function _attachPcardDelegation(container) {
    /* Remove any previously attached listener before re-attaching to avoid duplicates */
    container.removeEventListener('click', _productCardClick);
    container.addEventListener('click', _productCardClick);
}

/* =========================
   SELLER VERIFICATION BADGES
========================= */

/**
 * Returns badge HTML string for a given sellerName.
 * Reads from sokoniVerifiedSellers: { [sellerName]: { verifiedSeller, verifiedBusiness, verifiedShop, sameDayDelivery } }
 * size: "sm" (product card) | "lg" (seller profile)
 */
function getSellerBadgesHtml(sellerName, size){
    if(!sellerName) return '';
    var map = {};
    try { map = JSON.parse(localStorage.getItem('sokoniVerifiedSellers')||'{}'); } catch(e){}
    var b = map[sellerName] || {};
    var cls = size==='lg' ? 'vbadge vbadge-lg' : 'vbadge';
    var parts = [];
    if(b.verifiedSeller)  parts.push('<span class="'+cls+' vbadge-seller">✓ Verified Seller</span>');
    if(b.verifiedBusiness)parts.push('<span class="'+cls+' vbadge-business">✓ Verified Business</span>');
    if(b.verifiedShop)    parts.push('<span class="'+cls+' vbadge-shop">✓ Verified Shop</span>');
    if(b.sameDayDelivery) parts.push('<span class="'+cls+' vbadge-sameday">⚡ Same Day Delivery</span>');
    return parts.length ? '<div class="vbadge-row">'+parts.join('')+'</div>' : '';
}
window.getSellerBadgesHtml = getSellerBadgesHtml;

/** Grants or updates badges for a seller. Admin-callable. */
function grantSellerBadge(sellerName, badgeKey, value){
    if(!sellerName||!badgeKey) return;
    var map = {};
    try { map = JSON.parse(localStorage.getItem('sokoniVerifiedSellers')||'{}'); } catch(e){}
    if(!map[sellerName]) map[sellerName] = {};
    map[sellerName][badgeKey] = value !== false;
    localStorage.setItem('sokoniVerifiedSellers', JSON.stringify(map));
}
window.grantSellerBadge = grantSellerBadge;

/* =========================
   SCROLL POSITION MEMORY
========================= */

/* Scroll position — delegated to scroll-memory.js (loaded before this module).
   Keep saveHomeScroll / restoreHomeScroll as aliases so existing callers work. */
function saveHomeScroll(){
    if(window.sokoniSaveScroll) window.sokoniSaveScroll();
}
function restoreHomeScroll(){
    if(window.sokoniRestoreScroll) window.sokoniRestoreScroll();
}

/* =========================
   OPEN PRODUCT (whole-card tap)
========================= */

function openProduct(id){
    saveHomeScroll();
    const p = products.find(x => x.id === id);
    if(!p) return;
    localStorage.setItem("selectedProduct", JSON.stringify(p));
    if(typeof sokoniTrackProductView === "function") sokoniTrackProductView(p);
    window.location.href = "product.html";
}

window.openProduct = openProduct;

/* =========================
   DISPLAY PRODUCTS
========================= */

function displayProducts(productsToShow = []){

    const container = document.getElementById("productsContainer");
    if(!container) return;

    if(productsToShow.length === 0){
        container.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:60px 20px;">
                <div style="font-size:48px;margin-bottom:16px;">🛍️</div>
                <h2 style="color:white;margin-bottom:8px;">No products here yet</h2>
                <p style="color:rgba(255,255,255,0.4);margin-bottom:20px;">Sellers haven't added products to this category</p>
                <a href="seller.html" style="padding:12px 24px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;border-radius:12px;text-decoration:none;font-weight:800;">Become a Seller</a>
            </div>
        `;
        return;
    }

    /* Phase 8 — INP optimisation:
       Render first 12 cards synchronously (above/near fold), then hand the
       remaining batch to requestIdleCallback so it doesn't block the main
       thread during user interactions. Falls back to setTimeout on browsers
       that lack requestIdleCallback (Safari < 16). */
    const FIRST_BATCH = 12;
    const first  = productsToShow.slice(0, FIRST_BATCH);
    const rest   = productsToShow.slice(FIRST_BATCH);

    container.innerHTML = first.map(p => buildProductCard(p)).join('');

    /* Single delegated listener — handles both first batch and lazy-appended rest */
    _attachPcardDelegation(container);

    /* Phase 9 — stagger first batch cards */
    container.querySelectorAll('.product-card').forEach(function(card, i){
      card.style.setProperty('--p9i', (i * 0.04) + 's');
    });

    if (rest.length === 0) return;

    const scheduleIdle = window.requestIdleCallback
        ? (cb) => requestIdleCallback(cb, { timeout: 1500 })
        : (cb) => setTimeout(cb, 60);

    scheduleIdle(() => {
        /* Append rest without touching already-rendered first batch */
        const frag = document.createElement('div');
        frag.innerHTML = rest.map(p => buildProductCard(p)).join('');
        /* Phase 9 — stagger appended cards (offset index past first batch) */
        frag.querySelectorAll('.product-card').forEach(function(card, i){
            card.style.setProperty('--p9i', ((FIRST_BATCH + i) * 0.04) + 's');
        });
        while (frag.firstChild) container.appendChild(frag.firstChild);
    });
}

/* =========================
   FILTER WITH ACTIVE STATE
========================= */

function setFilter(btn, category){
    document.querySelectorAll(".cat-filter-btn, .ptrend-pill").forEach(b => {
        b.classList.remove("active-filter");
        b.classList.remove("active");
    });
    if(btn){ btn.classList.add("active-filter"); btn.classList.add("active"); }

    let filtered = category === "all" ? products : products.filter(
        p => p.category && p.category.toLowerCase() === category.toLowerCase()
    );

    if(activeLocation && activeLocation !== "all"){
        filtered = filtered.filter(p =>
            !p.location || p.location === "worldwide" || p.location === activeLocation
        );
    }

    /* Home page: cap at 8 — full catalogue lives on category.html */
    const isHome = /\/(index\.html)?$/.test(window.location.pathname.split('?')[0]);
    const HOME_TRENDING_LIMIT = 20;
    const display = isHome ? filtered.slice(0, HOME_TRENDING_LIMIT) : filtered;
    displayProducts(display);

    /* Show/hide "See All" footer on home page */
    const footer = document.getElementById("trendingSeeAllFooter");
    if(footer){
        const hidden = filtered.length - display.length;
        footer.style.display = isHome ? "block" : "none";
        const link = footer.querySelector("a");
        if(link) link.href = "category.html?cat=" + (category === "all" ? "all" : category);
        const countEl = footer.querySelector(".see-all-count");
        if(countEl) countEl.textContent = hidden > 0 ? "(+" + hidden + " more)" : "";
    }
}

window.setFilter = setFilter;

/* =========================
   FILTER PRODUCTS
========================= */

function filterProducts(category){


    /* ALL */

    if(category === "all"){

        displayProducts(products);

        return;
    }

    /* FILTER */

    const filteredProducts = products.filter(

        product =>

        product.category &&

        product.category.toLowerCase() ===

        category.toLowerCase()

    );


    displayProducts(filteredProducts);

}

/* =========================
   SEARCH PRODUCTS
========================= */

function searchProducts(){

    const searchValue = document

    .getElementById("searchInput")

    .value

    .toLowerCase();

    if(searchValue === ""){

        displayProducts(products);

        return;

    }

    const filteredProducts = products.filter(product =>

        product.name.toLowerCase()
        .includes(searchValue)

    );

    displayProducts(filteredProducts);

}

/* =========================
   BUY PRODUCT
========================= */

async function buyProduct(productId, _trigBtn){
    if (_trigBtn) { _trigBtn.dataset.loading = '1'; _trigBtn.disabled = true; }

    const selectedProduct = products.find(
        product => String(product.id) === String(productId)
    );

    if(!selectedProduct) {
        if (_trigBtn) { delete _trigBtn.dataset.loading; _trigBtn.disabled = false; }
        return;
    }

    /* 18+ age gate */
    if(typeof isAdultCategory === "function" && isAdultCategory(selectedProduct.category)){
        if(typeof requireAgeVerification === "function"){
            const verified = await requireAgeVerification();
            if(!verified) {
                if (_trigBtn) { delete _trigBtn.dataset.loading; _trigBtn.disabled = false; }
                return;
            }
        }
    }

    cart.push(selectedProduct);
    flyToCart(selectedProduct);
    selectedProduct.views = (selectedProduct.views || 0) + 1;
    updateCart();
    if(typeof sokoniTrackAddToCart === "function") sokoniTrackAddToCart(selectedProduct);
    showNotification("Added To Cart 🛒", "success");
    if (_trigBtn) { delete _trigBtn.dataset.loading; _trigBtn.disabled = false; }

    /* Phase 9 — cart-add flash on the product tile */
    const safeId = String(selectedProduct.id || '').replace(/[^a-zA-Z0-9_-]/g,'');
    const tile = document.querySelector('.product-card[onclick*="' + safeId + '"]');
    if (tile) {
      tile.classList.remove('p9-cart-flash');
      void tile.offsetWidth; /* reflow to restart animation */
      tile.classList.add('p9-cart-flash');
      tile.addEventListener('animationend', function(){ tile.classList.remove('p9-cart-flash'); }, { once: true });
    }
}

/* =========================
   BUY NOW
========================= */

async function buyNow(productId, _trigBtn){
    if (_trigBtn) { _trigBtn.dataset.loading = '1'; _trigBtn.disabled = true; }

    const selectedProduct = products.find(
        product => String(product.id) === String(productId)
    );

    if(!selectedProduct) {
        if (_trigBtn) { delete _trigBtn.dataset.loading; _trigBtn.disabled = false; }
        return;
    }

    /* 18+ age gate */
    if(typeof isAdultCategory === "function" && isAdultCategory(selectedProduct.category)){
        if(typeof requireAgeVerification === "function"){
            const verified = await requireAgeVerification();
            if(!verified) {
                if (_trigBtn) { delete _trigBtn.dataset.loading; _trigBtn.disabled = false; }
                return;
            }
        }
    }

    cart.push(selectedProduct);
    localStorage.setItem("cart", JSON.stringify(cart));
    updateCart();
    showNotification("Proceeding To Checkout 💳", "success");
    saveHomeScroll();
    window.location.href = "checkout.html";
}

/* WHATSAPP SHARE FROM CARD */

function shareProductWA(name, price){
    const decoded = decodeURIComponent(name);
    const text    = encodeURIComponent(`🛍️ "${decoded}" — KES ${Number(price).toLocaleString()} on SOKONI Kenya!\nhttps://mysokoni.co.ke`);
    window.open(`https://wa.me/?text=${text}`, "_blank");
}

/* QUICK OFFER FROM CARD */

function quickOffer(id, nameEnc, price){
    const name = decodeURIComponent(nameEnc);
    const offerAmt = prompt(`Make an offer for "${name}" (listed at KES ${Number(price).toLocaleString()}):\n\nEnter your offer price (KES):`);
    if(!offerAmt || isNaN(offerAmt)) return;
    const product = products.find(p=>p.id===id);
    const user = JSON.parse(localStorage.getItem("sokoniUser")||"null");
    const offer = {
        id:"OFF"+Date.now(), productId:id, productName:name,
        listedPrice:Number(price), offerPrice:Number(offerAmt),
        buyerName:user?.name||"Anonymous", sellerName:product?.sellerName||"Sokoni Seller",
        date:new Date().toLocaleDateString("en-KE",{day:"numeric",month:"short",year:"numeric"}),
        timestamp:Date.now(), status:"pending"
    };
    let offers=[]; try{offers=JSON.parse(localStorage.getItem("sokoniOffers"))||[];}catch(e){}
    offers.unshift(offer);
    localStorage.setItem("sokoniOffers", JSON.stringify(offers));
    showNotification(`Offer of KES ${Number(offerAmt).toLocaleString()} sent to seller!`, "success");
}

window.shareProductWA = shareProductWA;
window.quickOffer     = quickOffer;

/* ADD TO WISHLIST */

async function addToWishlist(productId){
    /* productId is the sanitized ID from safeId (alphanumeric + - _).
       We match against the same sanitization to be consistent. */
    const _mkSafe = id => String(id||'').replace(/[^a-zA-Z0-9_-]/g,'');

    const selectedProduct = products.find(p => _mkSafe(p.id) === productId);

    if(!selectedProduct) return;

    /* 18+ age gate */
    if(typeof isAdultCategory === "function" && isAdultCategory(selectedProduct.category)){
        if(typeof requireAgeVerification === "function"){
            const verified = await requireAgeVerification();
            if(!verified) return;
        }
    }

    const alreadyExists = wishlist.find(item => _mkSafe(item.id) === productId);

    /* REMOVE */
    if(alreadyExists){
        wishlist = wishlist.filter(item => _mkSafe(item.id) !== productId);
        localStorage.setItem("wishlist", JSON.stringify(wishlist));
        displayProducts(products);
        showNotification("Removed From Wishlist 💔", "error");
        return;
    }

    /* ADD */
    wishlist.push(Object.assign({}, selectedProduct, { savedPrice: selectedProduct.price, savedAt: new Date().toISOString() }));
    localStorage.setItem("wishlist", JSON.stringify(wishlist));
    trackWishlistDemand(selectedProduct.name, true);
    displayProducts(products);
    showNotification("Added To Wishlist ❤️", "success");

    /* Phase 9 — heart pop on the wishlist button */
    const safeWId = String(selectedProduct.id || '').replace(/[^a-zA-Z0-9_-]/g,'');
    const wishBtn = document.querySelector('.product-card[data-pid="' + safeWId + '"] .pcard-btn--wish, .product-card[data-pid="' + safeWId + '"] .pcard-m-wish');
    if (wishBtn) {
      wishBtn.classList.remove('p9-heart-pop');
      void wishBtn.offsetWidth;
      wishBtn.classList.add('p9-heart-pop');
      wishBtn.addEventListener('animationend', function(){ wishBtn.classList.remove('p9-heart-pop'); }, { once: true });
    }
}

/* =========================
   UPDATE CART
========================= */

function updateCart(){

    const cartItems =
    document.getElementById(
        "cartItems"
    );

    const cartTotal =
    document.getElementById(
        "cartTotal"
    );

    const cartCount =
    document.getElementById(
        "cartCount"
    );

    if(!cartItems) return;

    cartItems.innerHTML = "";

    let total = 0;

    if(cart.length === 0){

        cartItems.innerHTML = `

        <p class="empty-cart">

            Cart is empty 🛒

        </p>

        `;

    }

    cart.forEach((product,index)=>{

        total += Number(product.price);
        const _cartEsc = typeof escapeHTML === 'function' ? escapeHTML : function(s){ return String(s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); };

        cartItems.innerHTML += `

        <div class="cart-item">

            <div class="cart-info">

                <span class="cart-name">

                    ${_cartEsc(product.name)}

                </span>

                <span class="cart-price">

                    KES ${product.price}

                </span>

            </div>

            <button 

            class="remove-cart-btn"

            onclick="removeFromCart(${index})"

            >

                ✖

            </button>

        </div>

        `;

    });

    if(cartTotal){

        cartTotal.innerText = total;

    }

    if(cartCount){
        cartCount.innerText = cart.length;
    }

    const badge = document.getElementById("cartCountBadge");
    if(badge) {
      badge.innerText = cart.length;
      /* Phase 9 — badge pop micro-interaction */
      badge.classList.remove('p9-badge-pop');
      void badge.offsetWidth;
      badge.classList.add('p9-badge-pop');
      badge.addEventListener('animationend', function(){ badge.classList.remove('p9-badge-pop'); }, { once: true });
    }

    localStorage.setItem(

        "cart",

        JSON.stringify(cart)

    );

}

/* =========================
   REMOVE CART
========================= */

function removeFromCart(index){

    cart.splice(index,1);

    updateCart();

}

/* =========================
   NEW ARRIVALS
========================= */

/* =========================
   FEATURED SHOPS (home page)
========================= */

function displayFeaturedShops(){
    const section = document.getElementById("featuredShopsSection");
    const grid    = document.getElementById("featuredShopsGrid");
    if(!section || !grid) return;

    let featured = [];
    try { featured = JSON.parse(localStorage.getItem("sokoniFeaturedShops"))||[]; } catch(e){}
    const active  = featured.filter(f => f.endsAt > Date.now());

    section.style.display = "block";

    /* Delegate clicks on featured shop cards (avoids storeUrl injection in onclick=) */
    grid.addEventListener("click", function _fsClick(e) {
        const card = e.target.closest("[data-store-url]");
        if (!card) return;
        const url = card.dataset.storeUrl;
        /* Block javascript: protocol URLs — only allow http/https/relative paths */
        if (url && /^(https?:\/\/|\/|seller-public\.html)/i.test(url)) {
            window.location.href = url;
        }
    }, { once: false });

    if(!active.length){
        grid.innerHTML = `
        <div class="seller-card featured-shop-promo">
            <div class="fsp-crown">👑</div>
            <h3>Put Your Shop Here</h3>
            <p class="fsp-sub">Reach 10× more buyers. Your logo, your store — front and centre on Kenya's marketplace.</p>
            <div class="fsp-perks">
                <div class="fsp-perk">🌟 Homepage spotlight</div>
                <div class="fsp-perk">🔥 Priority placement</div>
                <div class="fsp-perk">📈 Proven sales boost</div>
            </div>
            <a href="seller.html" class="seller-visit-btn fsp-cta-btn">
                <i class="fas fa-bolt"></i> Boost My Shop
            </a>
            <div class="fsp-price">From KES 500 / week</div>
        </div>`;
        return;
    }

    const CITY = { nairobi:"Nairobi", mombasa:"Mombasa", kisumu:"Kisumu", nakuru:"Nakuru", eldoret:"Eldoret", thika:"Thika" };

    grid.innerHTML = active.map(f => {
        const initials     = (f.storeName||"S").substring(0,2).toUpperCase();
        const ratingHtml   = f.avgRating
            ? `<div class="fs-rating">⭐ ${f.avgRating} · ${f.salesCount||0} sales</div>`
            : `<div class="fs-rating">New store</div>`;
        const locationName = CITY[f.location] || f.location || "Kenya";
        const avatarInner  = f.logo
            ? `<img src="${f.logo}" alt="${f.storeName}" style="width:100%;height:100%;object-fit:contain;padding:8px;">`
            : `<span style="font-size:22px;font-weight:900;color:#f5a623;">${initials}</span>`;
        const avatarStyle  = f.logo ? "" : "background:linear-gradient(135deg,rgba(245,166,35,0.15),rgba(247,201,72,0.08));display:flex;align-items:center;justify-content:center;";
        return `
        <div class="seller-card featured-shop-card" data-store-url="${_escHtml(String(f.storeUrl||''))}" style="cursor:pointer;">
            <div class="featured-ribbon">
                <span class="featured-ribbon-star">★</span>
                SPOTLIGHT
                <span class="featured-ribbon-star">★</span>
            </div>
            <div class="seller-avatar" style="${avatarStyle}">${avatarInner}</div>
            <h3>${f.storeName}</h3>
            <div class="seller-location-tag">📍 ${locationName}</div>
            ${ratingHtml}
            ${f.tagline ? `<p class="fs-tagline">${f.tagline.substring(0,50)}</p>` : ""}
            <div class="seller-tags">
                <span class="seller-tag">📦 ${f.productCount||0} products</span>
            </div>
            <a href="${f.storeUrl}" class="seller-visit-btn fs-visit-btn" onclick="event.stopPropagation()">
                <i class="fas fa-store"></i> Visit Store
            </a>
        </div>`;
    }).join("") + `
        <div class="seller-card featured-shop-promo">
            <div class="fsp-crown">👑</div>
            <h3>Put Your Shop Here</h3>
            <p class="fsp-sub">Reach 10× more buyers. Your logo, your store — front and centre on Kenya's marketplace.</p>
            <div class="fsp-perks">
                <div class="fsp-perk">🌟 Homepage spotlight</div>
                <div class="fsp-perk">🔥 Priority placement</div>
                <div class="fsp-perk">📈 Proven sales boost</div>
            </div>
            <a href="seller.html" class="seller-visit-btn fsp-cta-btn">
                <i class="fas fa-bolt"></i> Boost My Shop
            </a>
            <div class="fsp-price">From KES 500 / week</div>
        </div>`;
}

function displayNewArrivals(){
    const section = document.getElementById("newArrivalsSection");
    const grid    = document.getElementById("newArrivalsGrid");
    if(!grid || !section) return;

    const newest = [...products].sort((a,b) => {
        const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
        const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
        return tb - ta;
    }).slice(0, 20);
    section.style.display = "block";
    grid.innerHTML = newest.map(p => buildProductCard(p, "compact")).join("");
}

/* =========================
   RECOMMENDED PRODUCTS
========================= */

function displayRecommendedProducts(){
    const section   = document.getElementById("recommendedSection");
    const container = document.getElementById("recommendedContainer");
    if(!container) return;

    // Recommended = shuffle products, show 6 on home page
    const shuffled = [...products].sort(() => Math.random() - 0.5).slice(0, 6);
    section.style.display = "block";
    container.innerHTML = shuffled.map(p => buildProductCard(p, "large")).join("")
      + (products.length > 6
          ? `<div style="grid-column:1/-1;text-align:center;padding:8px 0 12px;">
               <a href="category.html?cat=all"
                  style="display:inline-flex;align-items:center;gap:7px;padding:11px 24px;
                         background:rgba(113,255,0,0.07);border:1px solid rgba(113,255,0,0.22);
                         border-radius:12px;color:#71ff00;font-size:12px;font-weight:800;text-decoration:none;">
                 ✨ See All ${products.length}+ Products →
               </a>
             </div>` : "");

    /* Update marketplace stats with real counts */
    const statsSection = document.getElementById("marketplaceStats");
    if(statsSection) statsSection.style.display = "flex";
    const countEl = document.getElementById("statProductCount");
    if(countEl) countEl.textContent = Math.max(products.length, 500) + "+";
    const sellerEl = document.getElementById("statSellerCount");
    if(sellerEl){
        const sellers = new Set(products.map(p=>p.sellerEmail||p.sellerName)).size;
        sellerEl.textContent = Math.max(sellers, 120) + "+";
    }
}

/* =========================
   DAILY AUTO-SELECTIONS
========================= */

function displayFastestSelling(){
    const sec  = document.getElementById("fastestSellingSection");
    const grid = document.getElementById("fastestSellingGrid");
    if(!grid) return;
    const top = [...products]
        .filter(p => (p.sold || 0) > 0 && !p.outOfStock)
        .sort((a, b) => (b.sold || 0) - (a.sold || 0))
        .slice(0, 20);
    if(!top.length) return;
    grid.innerHTML = top.map(p => buildProductCard(p, "compact")).join("");
    if(sec) sec.style.display = "block";
}

function displayBiggestDiscounts(){
    const sec  = document.getElementById("biggestDiscountsSection");
    const grid = document.getElementById("biggestDiscountsGrid");
    if(!grid || !products.length) return;

    const withDiscount = products
        .filter(p => !p.outOfStock && p.priceHistory && p.priceHistory.length)
        .map(p => {
            /* Find the peak historical price as the "original" */
            const peakPrice = Math.max(...p.priceHistory.map(h => h.price || h.newPrice || 0), p.price);
            const disc = peakPrice > p.price ? Math.round((1 - p.price / peakPrice) * 100) : 0;
            return disc >= 5 ? { ...p, _discPct: disc, _origPrice: peakPrice } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b._discPct - a._discPct)
        .slice(0, 20);

    if(!withDiscount.length) return;
    grid.innerHTML = withDiscount.map(p => {
        const card = buildProductCard(p, "compact");
        /* Inject a prominent discount pill over the card by wrapping in a relative container */
        return card.replace(
            'style="position:relative;animation:cardFadeIn 0.4s ease;"',
            `style="position:relative;animation:cardFadeIn 0.4s ease;" data-disc="${p._discPct}"`
        ).replace(
            /(<div class="product-img-wrap">)/,
            `<div style="position:absolute;top:8px;left:8px;z-index:3;background:linear-gradient(135deg,#ff4444,#ff7700);color:white;font-size:11px;font-weight:900;padding:4px 10px;border-radius:20px;box-shadow:0 2px 8px rgba(255,68,68,0.4);">-${p._discPct}% OFF</div>$1`
        );
    }).join("");
    if(sec) sec.style.display = "block";
}

function displayTodaysPicks(){
    const sec  = document.getElementById("todaysPicksSection");
    const grid = document.getElementById("todaysPicksGrid");
    if(!grid || products.length < 4) return;

    /* Deterministic daily shuffle — same picks all day, changes at midnight */
    const dateSeed = new Date().toISOString().slice(0, 10)
        .split("").reduce((acc, c) => acc * 31 + c.charCodeAt(0), 1);
    let seed = dateSeed;
    function nextRand(max){
        seed = (seed * 1664525 + 1013904223) & 0xffffffff;
        return Math.abs(seed) % max;
    }
    const pool = [...products].filter(p => !p.outOfStock);
    for(let i = pool.length - 1; i > 0; i--){
        const j = nextRand(i + 1);
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picks = pool.slice(0, 20);
    grid.innerHTML = picks.map(p => buildProductCard(p, "compact")).join("");
    if(sec) sec.style.display = "block";
}

/* =========================
   LIVE SALES POPUP
========================= */

/* Live-popup interval handle — kept so disable() can kill it immediately */
let _livePopupInterval = null;

function _notifDisabled(){
    const s = localStorage.getItem('sokoniNotifState');
    if(s === 'off') return true;
    if(s === 'snoozed'){
        const until = parseInt(localStorage.getItem('sokoniNotifSnoozeUntil')||'0',10);
        return Date.now() < until;
    }
    return false;
}

function startLivePopup(){
    /* Fake-purchase notification disabled — fabricated names/cities violate
       platform honesty policy. Will be replaced with real recent-order data
       from productStats.salesLastPurchasedAt when the activity feed is built. */
    return;
}

/* =========================
   QUICK VIEW
========================= */

function openQuickView(productId){

    const product = products.find(

        item =>
        String(item.id) ===
        String(productId)

    );

    if(!product) return;

    const modal = document.getElementById(
        "quickViewModal"
    );

    if(!modal) return;

    const productImage =

    product.images?.[0] ||

    product.image ||

    "assets/default-product.png";

    document.getElementById(
        "quickViewImage"
    ).src = productImage;

    document.getElementById(
        "quickViewName"
    ).innerText = product.name;

    document.getElementById(
        "quickViewPrice"
    ).innerText =
    "KES " + product.price;

    document.getElementById(
        "quickViewCartBtn"
    ).onclick = ()=>{

        buyProduct(product.id);

    };

    modal.style.display = "flex";

}

/* =========================
   CLOSE QUICK VIEW
========================= */

function closeQuickView(){

    document.getElementById(
        "quickViewModal"
    ).style.display = "none";

}

/* =========================
   HERO SLIDER
========================= */


/* =========================
   SMART CHAT BOT
========================= */

/* ══════════════════════════════════════════
   SOKONI SMART BOT — Enhanced Knowledge Base
══════════════════════════════════════════ */
const botResponses = [
    /* ── Shopping & Orders ── */
    { keys:["track","order","where","delivery status","my order"], reply:"To track your order tap <a href='track.html' style='color:#71ff00'>📦 Track Order</a> and enter your Order ID (starts with SKN). Live map shows your rider in real-time! 🛵" },
    { keys:["pay","payment","mpesa","visa","card","how to pay","checkout"], reply:"We accept <strong>M-Pesa, Visa, Mastercard & PayPal</strong>. M-Pesa sends an STK push instantly to your phone. <a href='checkout.html' style='color:#71ff00'>Go to Checkout →</a> 💳" },
    { keys:["return","refund","wrong item","broken","damaged","replace"], reply:"<strong>7-day hassle-free returns.</strong> Got the wrong or damaged item? Message the seller via <a href='messages.html' style='color:#71ff00'>💬 Messages</a> or email info@sokoni.co.ke and we'll sort it within 24hrs. 🔄" },
    { keys:["deliver","shipping","how long","days","arrival","eta"], reply:"🚀 <strong>Nairobi:</strong> Same-day delivery<br>🏙️ <strong>Mombasa/Kisumu:</strong> 1–2 days<br>🌍 <strong>Other towns:</strong> 2–4 days<br>Track live on <a href='track.html' style='color:#71ff00'>Track Order</a> 🛵" },
    { keys:["cancel order","cancel","stop order"], reply:"To cancel an order, go to <a href='profile.html' style='color:#71ff00'>My Orders</a> and tap the order. Cancellations are free within 1 hour of placing. After that, contact support. ❌" },
    { keys:["invoice","receipt","proof"], reply:"Get a PDF invoice for any order at <a href='invoice.html' style='color:#71ff00'>🧾 Generate Invoice</a>. You can share or print it easily. 📄" },

    /* ── Selling ── */
    { keys:["sell","seller","upload product","how to sell","start selling","list product"], reply:"Selling is <strong>100% FREE</strong> on Sokoni! 🎉<br>1. Go to <a href='seller.html' style='color:#71ff00'>🏪 Seller Dashboard</a><br>2. Upload a photo + set your price<br>3. Go live instantly — thousands of buyers see you!" },
    { keys:["boost","promote","advertise","visibility","marketing"], reply:"Boost your listing to reach more buyers! 🚀<br>• <strong>Pro Boost</strong> — KES 500/week (homepage featured)<br>• <strong>VIP Boost</strong> — KES 1,500/14 days (hero banner)<br>Go to <a href='marketing.html' style='color:#71ff00'>📢 Marketing Hub</a>" },
    { keys:["commission","fee","sokoni charge","platform fee"], reply:"Sokoni charges only <strong>12% platform fee</strong> — you keep <strong>88%</strong>. That's almost double what Bolt or Uber Eats pays their people. Fair pay is our promise. 💰" },

    /* ── Healthcare ── */
    { keys:["hospital","clinic","doctor","dispensary","pharmacy","medicine","lab","blood test","nhif"], reply:"Sokoni has a full <a href='healthcare.html' style='color:#00c878'>🏥 Healthcare Hub</a>!<br>• Book hospital appointments<br>• Order medicine to your door (2hrs)<br>• Find labs, clinics & dispensaries<br>• Emergency: call 999 or 112 🚑" },
    { keys:["medicine","drugs","prescription","painkillers"], reply:"Order medicine delivered in <strong>2 hours</strong>! Visit <a href='healthcare.html' style='color:#00c878'>💊 Healthcare Hub</a> and tap 'Order Medicine'. Pay via M-Pesa on delivery. Works across Nairobi, Mombasa & Kisumu. 🛵" },
    { keys:["ambulance","emergency","accident","urgent"], reply:"🚨 <strong>EMERGENCY?</strong><br>📞 Call <strong>999</strong> (Police/Ambulance)<br>📞 Call <strong>112</strong> (Emergency Line)<br>Or visit <a href='healthcare.html' style='color:#00c878'>Healthcare Hub</a> to book AAR Ambulance now." },

    /* ── Entertainment ── */
    { keys:["dj","disc jockey","music","event music","party music"], reply:"Book Kenya's top DJs on <a href='entertainment.html' style='color:#c084fc'>🎧 Entertainment Hub</a>! From KES 8,000/night. DJ BVMBXNO and 10+ other DJs available for weddings, clubs & parties. 🎉" },
    { keys:["mc","emcee","host","event host","wedding host"], reply:"Find bilingual MCs for your event at <a href='entertainment.html' style='color:#c084fc'>🎤 Entertainment Hub</a>. English, Swahili, Sheng — from KES 15,000. Great for weddings, launches & galas! 💫" },
    { keys:["band","live music","live band","musicians"], reply:"Book live bands from <a href='entertainment.html' style='color:#c084fc'>🎸 Entertainment Hub</a>! Gospel, Afrojazz, Reggae, Contemporary. From KES 30,000 per event. 🎶" },
    { keys:["comedian","comedy","stand up","funny"], reply:"Need laughs? Book Kenya's top comedians at <a href='entertainment.html' style='color:#c084fc'>😂 Entertainment Hub</a>. Corporate-safe and family-friendly options available from KES 20,000. 🤣" },
    { keys:["photographer","photo","wedding photo","event photo"], reply:"Award-winning photographers at <a href='entertainment.html' style='color:#c084fc'>📸 Entertainment Hub</a>. Weddings, corporate, concerts — from KES 15,000. 48hr turnaround on edited photos! 🌟" },
    { keys:["entertainment","book performer","performer"], reply:"Sokoni has a full <a href='entertainment.html' style='color:#c084fc'>🎭 Entertainment Hub</a> — DJs, MCs, bands, comedians, photographers, videographers & dancers. Filter by genre, location & budget!" },

    /* ── Delivery / Driver ── */
    { keys:["driver","boda","rider","motorcycle","pickup","lorry","deliver for sokoni"], reply:"Join Sokoni as a delivery rider! 🛵 You keep <strong>88%</strong> of every delivery fee. E-Bikes, Bodas, Pickups, Canters & Lorries welcome. <a href='driver.html' style='color:#71ff00'>Apply Now →</a>" },
    { keys:["ebike","electric bike","charging cost","fuel cost"], reply:"Sokoni tracks fuel & charging costs automatically for all vehicle types! E-bike riders pay only KES 0.23/km. Compare: petrol motorbike costs ~KES 5/km. <a href='driver.html' style='color:#71ff00'>See Driver Hub →</a> ⚡" },
    { keys:["lorry","truck","cargo","freight","bulk delivery"], reply:"Need to move heavy cargo? Sokoni has lorry (up to 20 tonnes), canter (7 tonnes) and pickup (3 tonnes) drivers. <a href='driver.html' style='color:#71ff00'>Book a Driver →</a> 🚚" },

    /* ── Account & Profile ── */
    { keys:["account","login","register","signup","create account"], reply:"Creating an account is free and takes 30 seconds! <a href='signup.html' style='color:#71ff00'>Create Account →</a><br>Benefits: track orders, earn loyalty points, message sellers & more. 🔑" },
    { keys:["points","loyalty","reward","earn points","sokoni points"], reply:"🌟 <strong>Sokoni Loyalty Points:</strong><br>• Earn 1 pt per KES 10 spent<br>• 100 pts = 5% discount<br>• 500 pts = Free cap<br>• 1000 pts = Free hoodie<br>View yours in <a href='profile.html' style='color:#71ff00'>Profile →</a>" },
    { keys:["referral","refer","invite friend"], reply:"Refer a friend and earn <strong>KES 200</strong> when they make their first purchase! Share your referral link from <a href='referral.html' style='color:#71ff00'>Refer & Earn →</a> 🤝" },

    /* ── Products & Categories ── */
    { keys:["flash sale","discount","deal","offer","cheap","sale"], reply:"⚡ <a href='flashsale.html' style='color:#71ff00'>Flash Sale</a> is LIVE! Up to 50% off on selected items. Deals change daily — grab them before they're gone! 🔥" },
    { keys:["bnb","hotel","stay","accommodation","book room"], reply:"Find and book stays across Kenya at <a href='bnb.html' style='color:#71ff00'>🏨 BnB & Stays</a>. Landlords can list their properties for free! 🏡" },
    { keys:["property","house","rent","landlord","tenant","apartment"], reply:"Browse rental listings at <a href='property.html' style='color:#71ff00'>🏠 Properties</a> — houses, apartments, offices across Kenya. Landlords can list free! 🔑" },
    { keys:["car","vehicle","buy car","sell car","auto","spare parts"], reply:"Browse <a href='category.html?cat=cars' style='color:#71ff00'>🚗 Cars & Automotive</a> — vehicles, bikes, spare parts from verified sellers. New listings daily! 🏎️" },
    { keys:["b2b","wholesale","bulk","business to business"], reply:"Need bulk orders? Visit <a href='b2b.html' style='color:#71ff00'>🤝 B2B Wholesale</a> — negotiate directly with suppliers for large quantities at business prices. 📦" },
    { keys:["digital","ebook","course","software","download"], reply:"Find digital products at <a href='tech-hub.html' style='color:#71ff00'>💻 Digital & eSoko</a> — eBooks, courses, software and more. Instant download after purchase! 📲" },

    /* ── Support ── */
    { keys:["contact","phone","email","support","help","human","agent"], reply:"📞 <a href='tel:+254705726803' style='color:#71ff00'>+254 705 726 803</a><br>📧 <a href='mailto:info@sokoni.co.ke' style='color:#71ff00'>info@sokoni.co.ke</a><br>💬 <a href='https://wa.me/254705726803' style='color:#71ff00'>WhatsApp (fastest)</a><br>⏰ Support: Mon–Sat 7am–10pm" },
    { keys:["dispute","scam","fraud","not received","cheated"], reply:"We take disputes seriously! 🔒 Go to <a href='dispute.html' style='color:#ff9800'>⚠️ Report Dispute</a> and describe the issue. We investigate within 24 hours and protect your money. 💪" },
    { keys:["community","forum","ask question","post","review"], reply:"Join the <a href='community.html' style='color:#71ff00'>💬 Sokoni Community</a>! Ask questions, share reviews, recommend sellers and connect with other buyers and sellers across Kenya. 🌍" },

    /* ── Greetings ── */
    { keys:["hello","hi","hey","hujambo","habari","sasa","niaje","wazzup","howdy"], reply:(() => {
        const h = new Date().getHours();
        const greet = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
        return `${greet}! 👋 Welcome to SOKONI — Kenya's #1 marketplace!<br>How can I help you today? You can ask me about products, delivery, selling, healthcare, events and more! 😊`;
    })() },
    { keys:["thank","asante","sawa","okay","ok","nice","great","perfect","awesome"], reply:"You're most welcome! 😊🌟 Happy shopping on Sokoni. Your loyalty points are growing with every purchase. Anything else I can help with?" },
    { keys:["bye","goodbye","later","tutaonana","kwaheri"], reply:"Goodbye! 👋 Come back soon — new products and deals are added every day on Sokoni! See you! 🛍️" },

    /* ── Adult / 18+ ── */
    { keys:["18","adult","alcohol","vape","tobacco","spirits"], reply:"Adult products (18+) are available after age & ID verification. You'll be asked for your date of birth and Kenya National ID. Fully secure — we verify locally on your device only. 🔞" },
];

/* Search products from localStorage for the user */
function _searchProducts(query){
    try {
        const all = JSON.parse(localStorage.getItem("sellerProducts")) || [];
        const q = query.toLowerCase();
        return all.filter(p =>
            p.name?.toLowerCase().includes(q) ||
            p.category?.toLowerCase().includes(q) ||
            (p.description||"").toLowerCase().includes(q)
        ).slice(0,3);
    } catch(e){ return []; }
}

function botReply(message){
    const lower = message.toLowerCase();

    /* Product search — if user types "find X" / "show X" / "looking for X" / "buy X" */
    const searchPhrases = ["find ","show me ","looking for ","i want ","buy ","search for ","do you have ","ni","nataka "];
    const isSearch = searchPhrases.some(p => lower.startsWith(p)) || lower.length > 3 && !lower.includes("?") && lower.split(" ").length <= 4;
    if(isSearch){
        const term = lower.replace(/^(find|show me|looking for|i want|buy|search for|do you have|nataka|ni)\s*/i,"").trim();
        if(term.length >= 3){
            const found = _searchProducts(term);
            if(found.length){
                const _esc = typeof escapeHTML === 'function' ? escapeHTML : function(s){ return String(s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); };
                const cards = found.map(p =>
                    `<a href="product.html" onclick="localStorage.setItem('selectedProduct',JSON.stringify(${JSON.stringify(JSON.stringify(p))}))" style="display:block;background:rgba(113,255,0,0.06);border:1px solid rgba(113,255,0,0.18);border-radius:10px;padding:8px 10px;margin-top:6px;color:white;text-decoration:none;">
                        <strong style="color:#71ff00;">${_esc(p.name)}</strong><br>
                        <span style="font-size:11px;color:rgba(255,255,255,0.5);">KES ${Number(p.price).toLocaleString()} · ${_esc(p.location||"Kenya")}</span>
                    </a>`
                ).join("");
                return `Found <strong>${found.length} result${found.length>1?"s":""}</strong> for "<strong>${_esc(term)}</strong>"!${cards}<br><a href="category.html?q=${encodeURIComponent(term)}" style="color:#71ff00;font-size:11px;">See all results →</a>`;
            }
        }
    }

    const match = botResponses.find(r => r.keys.some(k => lower.includes(k)));
    if(match) return match.reply;

    /* Fallback — proactive help */
    const fallbacks = [
        "I'm not sure about that, but I can help with orders, delivery, selling, healthcare & events! Try asking: <em>'How do I track my order?'</em> or <em>'How do I sell on Sokoni?'</em> 😊",
        "Hmm, let me get a human to help! 👤 Reach us on <a href='https://wa.me/254705726803' style='color:#71ff00'>WhatsApp</a> (fastest) or call <a href='tel:+254705726803' style='color:#71ff00'>+254 705 726 803</a>.",
        "I didn't quite get that! Try rephrasing or ask something like:<br>• <em>'Where is my order?'</em><br>• <em>'I want to sell on Sokoni'</em><br>• <em>'Book a DJ for my event'</em> 🎉",
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

function addBotMessage(text){
    const messages = document.getElementById("chatMessages");
    if(!messages) return;
    const wrap = document.createElement("div");
    wrap.className = "bot-msg-wrap";
    const bubble = document.createElement("div");
    bubble.className = "bot-bubble";
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
}

function addUserMessage(text){
    const messages = document.getElementById("chatMessages");
    if(!messages) return;
    const div = document.createElement("div");
    div.className = "user-bubble-wrap";
    const bubble = document.createElement("div");
    bubble.className = "user-bubble";
    bubble.textContent = text;
    div.appendChild(bubble);
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
}

function toggleChat(){
    const box = document.getElementById("chatBox");
    const pip = document.getElementById("chatPip");
    if(!box) return;
    const isOpen = box.style.display !== "none";
    box.style.display = isOpen ? "none" : "flex";
    if(pip) pip.style.display = "none";
    if(!isOpen) document.getElementById("chatInput")?.focus();
}

function quickReply(text){
    const input = document.getElementById("chatInput");
    if(input){ input.value = text; }
    sendMessage();
}

const _CHAT_FN = "https://us-central1-sokoni-aeb26.cloudfunctions.net/sokoniChat";
const _chatHistory = []; /* conversation history for multi-turn context */
const _CHAT_MAX    = 40; /* 20 turns — cap prevents unbounded memory growth */

function sendMessage(){
    const input = document.getElementById("chatInput");
    if(!input) return;
    const text = input.value.trim();
    if(!text) return;
    const qr = document.getElementById("quickReplies");
    if(qr) qr.remove();
    addUserMessage(text);
    input.value = "";
    _chatHistory.push({ role: "user", content: text });
    if (_chatHistory.length > _CHAT_MAX) _chatHistory.splice(0, _chatHistory.length - _CHAT_MAX);

    const msgs = document.getElementById("chatMessages");
    const thinking = document.createElement("div");
    thinking.className = "bot-msg-wrap";
    thinking.id = "botThinking";
    thinking.innerHTML = `<div class="bot-bubble thinking"><span></span><span></span><span></span></div>`;
    msgs?.appendChild(thinking);
    if(msgs) msgs.scrollTop = msgs.scrollHeight;

    fetch(_CHAT_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: _chatHistory.slice(-10) }),
    })
    .then(r => r.json())
    .then(data => {
        document.getElementById("botThinking")?.remove();
        const reply = data.response || data.error || botReply(text);
        _chatHistory.push({ role: "assistant", content: reply });
        addBotMessage(reply);
    })
    .catch(() => {
        document.getElementById("botThinking")?.remove();
        const fallback = botReply(text);
        _chatHistory.push({ role: "assistant", content: fallback });
        addBotMessage(fallback);
    });
}

window.toggleChat  = toggleChat;
window.sendMessage = sendMessage;
window.quickReply  = quickReply;

function showChatPip(){
    if(localStorage.getItem("sokoniNotifState") === "off") return;
    setTimeout(() => {
        const pip = document.getElementById("chatPip");
        if(pip) pip.style.display = "flex";
    }, 4000);
}

/* Proactive greeting — pops a tip bubble above the KASS AI button after 8s */
function _startProactiveChat(){
    if(localStorage.getItem("sokoniNotifState") === "off") return;
    setTimeout(() => {
        const kassBtn = document.getElementById("kassBtn");
        if(!kassBtn || document.getElementById("_chatProactiveTip")) return;
        const tip = document.createElement("div");
        tip.id = "_chatProactiveTip";
        const h = new Date().getHours();
        const msgs = [
            "👋 Hi! Need help finding something?",
            "🔥 Flash deals are live! Ask me for a discount code.",
            "💊 Need medicine delivered? Ask me how!",
            "🎧 Planning an event? I can help you book a DJ!",
            h < 12 ? "☀️ Good morning! What can I help you with today?" : h < 17 ? "🌤️ Good afternoon! Can I help you find something?" : "🌙 Good evening! Looking for something specific?",
        ];
        const msg = msgs[Math.floor(Math.random() * msgs.length)];
        tip.style.cssText = "position:fixed;bottom:148px;right:14px;background:#1a1a1a;border:1px solid rgba(113,255,0,0.3);border-radius:14px 14px 4px 14px;padding:10px 14px;font-size:13px;color:white;font-family:'Segoe UI',system-ui,sans-serif;z-index:10000;max-width:200px;box-shadow:0 8px 24px rgba(0,0,0,0.4);animation:chatTipIn .3s ease;line-height:1.4;cursor:pointer;";
        tip.innerHTML = msg + `<div style="font-size:10px;color:rgba(113,255,0,0.7);margin-top:4px;font-weight:700;">Ask KASS →</div>`;
        if(!document.getElementById("_chatTipStyle")){
            const s = document.createElement("style");
            s.id = "_chatTipStyle";
            s.textContent = "@keyframes chatTipIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}";
            document.head.appendChild(s);
        }
        tip.onclick = () => { tip.remove(); kassBtn.click(); };
        document.body.appendChild(tip);
        setTimeout(() => { tip.style.opacity="0"; tip.style.transition="opacity .4s"; setTimeout(()=>tip.remove(),400); }, 7000);
    }, 8000);
}
_startProactiveChat();

/* =========================
   SPLASH SCREEN
========================= */


/* =========================
   FLY TO CART
========================= */

function flyToCart(product){

    const cartBtn =
    document.getElementById(
        "cartButton"
    );

    if(!cartBtn) return;

    const flyingImage =
    document.createElement("img");

    flyingImage.src =

    product.images?.[0] ||

    product.image ||

    "assets/default-product.png";

    flyingImage.classList.add(
        "flying-product"
    );

    document.body.appendChild(
        flyingImage
    );

    const startX =
    window.innerWidth / 2;

    const startY =
    window.innerHeight / 2;

    flyingImage.style.left =
    startX + "px";

    flyingImage.style.top =
    startY + "px";

    const cartRect =
    cartBtn.getBoundingClientRect();

    setTimeout(()=>{

        flyingImage.style.left =
        cartRect.left + "px";

        flyingImage.style.top =
        cartRect.top + "px";

        flyingImage.style.width =
        "20px";

        flyingImage.style.height =
        "20px";

        flyingImage.style.opacity =
        "0";

    },50);

    setTimeout(()=>{

        flyingImage.remove();

    },1000);

}

/* =========================
   THEME TOGGLE
========================= */

function toggleTheme(){

    document.body.classList.toggle("light-mode");

    const isLight = document.body.classList.contains("light-mode");

    localStorage.setItem("theme", isLight ? "light" : "dark");

    const btn = document.getElementById("themeToggleBtn");
    if(btn) btn.textContent = isLight ? "☀️" : "🌙";

}

const savedTheme = localStorage.getItem("theme");

if(savedTheme === "light"){
    document.body.classList.add("light-mode");
    const btn = document.getElementById("themeToggleBtn");
    if(btn) btn.textContent = "☀️";

}

/* =========================
   FLASH SALE HOMEPAGE
========================= */

function loadFlashSale(){
    let flashSales = [];
    let allProducts = [];
    try { flashSales = JSON.parse(localStorage.getItem("sokoniFlashSales")) || []; } catch(e) {}
    try { allProducts = JSON.parse(localStorage.getItem("sellerProducts")) || []; } catch(e) {}

    const active = flashSales.filter(f => f.endsAt > Date.now());
    if(active.length === 0) return;

    const bar     = document.getElementById("flashSaleBar");
    const section = document.getElementById("flashSection");
    if(bar) bar.style.display = "block";
    if(section) section.style.display = "block";

    const nearestEnd = Math.min(...active.map(f => f.endsAt));

    function tick(){
        const diff = nearestEnd - Date.now();
        if(diff <= 0) return;
        const h = String(Math.floor(diff/3600000)).padStart(2,"0");
        const m = String(Math.floor((diff%3600000)/60000)).padStart(2,"0");
        const s = String(Math.floor((diff%60000)/1000)).padStart(2,"0");
        ["cdHours","cdMins","cdSecs"].forEach((id,i) => { const el=document.getElementById(id); if(el) el.textContent=[h,m,s][i]; });
        const mini = document.getElementById("flashTimerMini");
        if(mini) mini.textContent = `${h}:${m}:${s}`;
    }
    tick();
    setInterval(tick, 1000);

    const grid = document.getElementById("flashProductsGrid");
    if(!grid) return;

    /* Delegate clicks for flash sale cards — safe, no raw product IDs in onclick= */
    grid.addEventListener("click", function(e){
        const item = e.target.closest("[data-action='open'][data-pid]");
        if(item && item.dataset.pid) openProduct(item.dataset.pid);
    });
    const flashItems = active.map(f => {
        const p = allProducts.find(p => p.id === f.productId);
        if(!p) return null;
        return { ...p, discount:f.discount, salePrice: Math.round(p.price*(1-f.discount/100)) };
    }).filter(Boolean);

    /* Home page: show max 4 flash items — rest live on flashsale.html */
    const HOME_FLASH_LIMIT = 4;
    const preview   = flashItems.slice(0, HOME_FLASH_LIMIT);
    const remaining = flashItems.length - preview.length;

    grid.innerHTML = preview.map(p => {
        const hasImg = p.image && (p.image.startsWith('data:') || p.image.startsWith('http'));
        const imgBlock = hasImg
            ? `<img src="${p.image}" alt="${p.name}" loading="lazy" decoding="async" style="width:100%;aspect-ratio:4/3;object-fit:cover;display:block;flex-shrink:0;">`
            : `<div style="width:100%;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;background:${p.bg||'linear-gradient(135deg,#1a1a2e,#16213e)'};flex-shrink:0;"><span style="font-size:52px;line-height:1">${p.emoji||'🛍️'}</span></div>`;
        return `<div class="fs-item" style="cursor:pointer;" data-pid="${String(p.id||'').replace(/[^a-zA-Z0-9_-]/g,'')}" data-action="open">
            <span class="fs-badge">-${p.discount}%</span>
            ${imgBlock}
            <div class="fs-body">
                <div class="fs-name">${p.name}</div>
                <div class="fs-prices">
                    <span class="fs-orig">KES ${Number(p.price).toLocaleString()}</span>
                    <span class="fs-sp">KES ${Number(p.salePrice).toLocaleString()}</span>
                </div>
            </div>
            <div class="fs-btns">
                <div class="fs-btn-row">
                    <button style="flex:1;padding:8px 4px;background:rgba(113,255,0,.1);border:1px solid rgba(113,255,0,.28);color:#71ff00;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:3px;" onclick="event.stopPropagation();buyProduct('${p.id}')">🛒 Cart</button>
                    <button style="flex:0 0 40px;padding:8px 4px;background:rgba(255,80,80,.1);border:1px solid rgba(255,80,80,.28);color:#ff6060;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;" onclick="event.stopPropagation()">❤️</button>
                </div>
                <button style="width:100%;padding:9px 4px;background:linear-gradient(135deg,#71ff00,#4fc800);border:none;color:#050f05;border-radius:8px;font-size:11px;font-weight:900;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:3px;" onclick="event.stopPropagation();buyNow('${p.id}')">⚡ Buy Now</button>
            </div>
        </div>`;
    }).join("")
    + `<div style="grid-column:1/-1;text-align:center;padding:8px 0 16px;">
        <a href="flashsale.html" style="display:inline-flex;align-items:center;gap:8px;padding:12px 28px;
           background:linear-gradient(135deg,rgba(239,68,68,0.12),rgba(239,68,68,0.06));
           border:1px solid rgba(239,68,68,0.3);border-radius:14px;
           color:#ff6b6b;font-size:13px;font-weight:800;text-decoration:none;transition:all .2s;"
           onmouseover="this.style.background='linear-gradient(135deg,rgba(239,68,68,0.2),rgba(239,68,68,0.1))'"
           onmouseout="this.style.background='linear-gradient(135deg,rgba(239,68,68,0.12),rgba(239,68,68,0.06))'">
          ⚡ See All Flash Deals${remaining > 0 ? ' (+' + remaining + ' more)' : ''} →
        </a>
       </div>`;
}

/* =========================
   FILTER BY LOCATION
========================= */

let activeLocation = "all";

function filterByLocation(location){
    activeLocation = location;
    const locEl = document.getElementById("locationFilter");
    if(locEl) locEl.value = location;

    // Find the currently active category filter (pill or legacy button)
    const activeBtn = document.querySelector(".ptrend-pill.active-filter, .cat-filter-btn.active-filter");
    const activeCategory = activeBtn?.textContent?.trim() || "all";
    // Map pill labels back to category keys
    const catMap = {
      "🛒 All":"all","📱 Electronics":"electronics","👗 Fashion":"fashion",
      "💄 Beauty":"beauty","👟 Shoes":"shoes","🛒 Groceries":"food",
      "💻 Computers":"computers","🔌 Appliances":"appliances","⚽ Sports":"sports",
      "🛋️ Furniture":"furniture","🖨️ Printing":"printing","👜 Accessories":"accessories",
      "🏗️ Construction":"construction","🔥 Gas & Fuel":"gas",
      "🌍 All":"all","👕 Fashion":"fashion","⌚ Accessories":"accessories","🍺 18+":"alcohol"
    };
    const currentCat = catMap[activeCategory] || "all";

    let filtered = currentCat === "all" ? products : products.filter(
        p => p.category && p.category.toLowerCase() === currentCat.toLowerCase()
    );

    if(location !== "all"){
        filtered = filtered.filter(p =>
            !p.location || p.location === "worldwide" || p.location === location
        );
    }

    displayProducts(filtered);
}

window.filterByLocation = filterByLocation;

/* =========================
   PROFILE ICON IN NAVBAR
========================= */

function loadNavProfile(){
    let user = null;
    try { user = JSON.parse(localStorage.getItem("sokoniUser")); } catch(e) {}
    const avatar  = document.getElementById("navProfileAvatar");
    const initial = document.getElementById("navProfileInitial");
    if(!avatar || !initial) return;
    if(user && (user.name || user.email || user.phone)){
        const label = user.name || user.email || user.phone || "";
        initial.textContent = label ? label[0].toUpperCase() : "👤";
        avatar.classList.add("nav-profile-logged-in");
        const authDiv = document.getElementById("authButtons");
        if(authDiv) authDiv.style.setProperty("display", "none", "important");
        /* Hide login/signup from mobile menu drawer when logged in */
        const ml = document.getElementById("mmenuLoginLink");
        const ms = document.getElementById("mmenuSignupLink");
        if(ml) ml.style.display = "none";
        if(ms) ms.style.display = "none";
    }
}

/* =========================
   NAVBAR POINTS
========================= */

function loadNavPoints(){
    let pts = 0;
    try { pts = JSON.parse(localStorage.getItem("sokoniPoints"))?.total || 0; } catch(e) {}
    const btn = document.getElementById("navPointsBtn");
    const el  = document.getElementById("navPoints");
    if(pts > 0 && btn){ btn.style.display = "flex"; if(el) el.textContent = pts; }

    let msgs = [];
    try { msgs = JSON.parse(localStorage.getItem("sokoniMessages")) || []; } catch(e) {}
    const unread = msgs.reduce((s,c) => s + (c.unread||0), 0);
    const dot = document.getElementById("unreadBadge");
    if(dot && unread > 0) dot.style.display = "inline-block";
}

/* =========================
   INITIALIZE
========================= */

function init(){
    /* One-time cleanup: remove any accidentally saved emails/phones from search history */
    try {
        var _ss = JSON.parse(localStorage.getItem("sokoniSavedSearches")||"[]");
        var _ssClean = _ss.filter(function(s){ return !/@/.test(s) && !/^\+?\d{7,}$/.test(s.trim()); });
        if(_ssClean.length !== _ss.length) localStorage.setItem("sokoniSavedSearches", JSON.stringify(_ssClean));
    } catch(e){}

    /* Save scroll on any internal link click so fast taps are captured */
    document.addEventListener("click", function(e){
        const a = e.target.closest("a[href]");
        if(a && !a.href.startsWith("javascript") && !a.target){
            saveHomeScroll();
        }
    }, { capture: true, passive: true });

    loadProducts();
    updateCart();
    loadFlashSale();
    loadNavPoints();
    loadNavProfile();
    loadHomepageReviews();
    startSokoniMarketing();
}

if(
    document.readyState === "complete" ||
    document.readyState === "interactive"
){
    init();
} else {
    window.addEventListener("DOMContentLoaded", init);
}

/* =========================
   GLOBAL FUNCTIONS
========================= */

window.buyProduct = buyProduct;
window.buyNow = buyNow;
window.addToWishlist = addToWishlist;

/* ==============================================
   WISHLIST DEMAND TRACKING
============================================== */

/* Called by addToWishlist — increment wishlistCount on product */
function trackWishlistDemand(productName, add = true){
    let prods = [];
    try { prods = JSON.parse(localStorage.getItem("sellerProducts"))||[]; } catch(e){}
    const idx = prods.findIndex(p => p.name === productName);
    if(idx === -1) return;
    prods[idx].wishlistCount = Math.max(0, (Number(prods[idx].wishlistCount)||0) + (add ? 1 : -1));
    localStorage.setItem("sellerProducts", JSON.stringify(prods));
}

window.trackWishlistDemand = trackWishlistDemand;

/* ==============================================
   PRODUCT COMPARISON
============================================== */

let compareList = [];

function toggleCompare(productId){
    const product = products.find(p => String(p.id) === String(productId));
    if(!product) return;

    const idx = compareList.findIndex(p => String(p.id) === String(productId));
    if(idx !== -1){
        compareList.splice(idx, 1);
        const btn = document.getElementById("cmp-" + productId);
        if(btn) btn.classList.remove("compare-active");
    } else {
        if(compareList.length >= 3){
            showNotification("Max 3 products to compare", "error"); return;
        }
        compareList.push(product);
        const btn = document.getElementById("cmp-" + productId);
        if(btn) btn.classList.add("compare-active");
    }
    renderCompareBar();
}

function renderCompareBar(){
    let bar = document.getElementById("compareBar");
    if(!bar){
        bar = document.createElement("div");
        bar.id = "compareBar";
        bar.className = "compare-bar";
        document.body.appendChild(bar);
    }
    if(compareList.length === 0){ bar.style.display = "none"; return; }
    bar.style.display = "flex";
    bar.innerHTML = `
        <div class="cb-left">
            <span class="cb-title">⇄ Compare (${compareList.length}/3)</span>
            ${compareList.map((p,i)=>`
                <div class="cb-item">
                    <img src="${p.image||'assets/default-product.png'}" onerror="this.src='assets/default-product.png'">
                    <span>${_escHtml(p.name.substring(0,22))}${p.name.length>22?"…":""}</span>
                    <button data-compare-remove="${i}">✕</button>
                </div>
            `).join("")}
        </div>
        <div class="cb-right">
            ${compareList.length >= 2 ? `<button class="cb-compare-btn" data-compare-action="open">Compare Now →</button>` : `<span style="font-size:12px;color:rgba(255,255,255,0.4);">Add ${2-compareList.length} more to compare</span>`}
            <button class="cb-clear-btn" data-compare-action="clear">Clear</button>
        </div>
    `;

    /* Delegate compare bar actions — avoids product IDs in onclick= strings */
    bar.addEventListener("click", function(e){
        const removeBtn = e.target.closest("[data-compare-remove]");
        if(removeBtn){
            const idx = parseInt(removeBtn.dataset.compareRemove, 10);
            if(!isNaN(idx) && compareList[idx]) toggleCompare(compareList[idx].id);
            return;
        }
        const actionBtn = e.target.closest("[data-compare-action]");
        if(actionBtn){
            if(actionBtn.dataset.compareAction === "open") openCompareModal();
            if(actionBtn.dataset.compareAction === "clear") clearCompare();
        }
    });
}

function clearCompare(){
    compareList.forEach(p => {
        const btn = document.getElementById("cmp-" + p.id);
        if(btn) btn.classList.remove("compare-active");
    });
    compareList = [];
    renderCompareBar();
}

function openCompareModal(){
    let modal = document.getElementById("compareModal");
    if(!modal){
        modal = document.createElement("div");
        modal.id = "compareModal";
        modal.className = "compare-modal-overlay";
        document.body.appendChild(modal);
    }

    const rows = [
        { label:"Image",       fn: p => `<img src="${p.image||'assets/default-product.png'}" style="width:90px;height:90px;object-fit:cover;border-radius:12px;">` },
        { label:"Name",        fn: p => `<strong>${p.name}</strong>` },
        { label:"Price",       fn: p => `<span style="color:#71ff00;font-weight:800;">KES ${Number(p.price).toLocaleString()}</span>` },
        { label:"Price Trend", fn: p => priceChangeBadge(p) || `<span style="color:rgba(255,255,255,0.3);">Stable</span>` },
        { label:"Category",    fn: p => p.category||"—" },
        { label:"Location",    fn: p => p.location||"—" },
        { label:"Stock",       fn: p => p.stock!==undefined ? (p.outOfStock?"<span style='color:#ff4444'>Out of Stock</span>":p.stock+" units") : "—" },
        { label:"Demand",      fn: p => p.wishlistCount ? `❤️ ${p.wishlistCount} wishlists` : "—" },
        { label:"Description", fn: p => p.description||"—" },
        { label:"KEBS",        fn: p => p.kebsCert ? `✅ ${p.kebsCert}` : "—" },
    ];

    modal.innerHTML = `
        <div class="compare-modal-box">
            <button class="compare-modal-close" onclick="document.getElementById('compareModal').style.display='none'">✕</button>
            <h2 class="compare-modal-title">⇄ Product Comparison</h2>
            <div style="overflow-x:auto;">
                <table class="compare-table">
                    <thead>
                        <tr>
                            <th>Feature</th>
                            ${compareList.map(p=>`<th>${p.name.substring(0,20)}</th>`).join("")}
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(row=>`
                            <tr>
                                <td class="compare-row-label">${row.label}</td>
                                ${compareList.map(p=>`<td class="compare-row-val">${row.fn(p)}</td>`).join("")}
                            </tr>
                        `).join("")}
                        <tr>
                            <td class="compare-row-label">Actions</td>
                            ${compareList.map((p,i)=>`
                                <td class="compare-row-val">
                                    <button class="cb-compare-btn" style="margin-bottom:6px;width:100%;" data-cmp-action="cart" data-cmp-idx="${i}">🛒 Cart</button>
                                    <button class="cb-compare-btn" style="background:rgba(255,140,0,0.15);color:#ff9800;width:100%;" data-cmp-action="buy" data-cmp-idx="${i}">Buy Now</button>
                                </td>
                            `).join("")}
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    `;
    modal.style.display = "flex";

    /* Delegate compare modal Cart/Buy Now actions — safe, uses compareList index */
    modal.addEventListener("click", function(e){
        const btn = e.target.closest("[data-cmp-action]");
        if(!btn) return;
        const idx = parseInt(btn.dataset.cmpIdx, 10);
        const p   = compareList[idx];
        if(!p) return;
        if(btn.dataset.cmpAction === "cart") buyProduct(p.id);
        if(btn.dataset.cmpAction === "buy")  buyNow(p.id);
    });
}

window.toggleCompare    = toggleCompare;
window.clearCompare     = clearCompare;
window.openCompareModal = openCompareModal;

/* ==============================================
   RECENTLY VIEWED PRODUCTS
============================================== */

function trackRecentlyViewed(product){
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem("sokoniRecentlyViewed"))||[]; } catch(e){}
  recent = recent.filter(p => p.id !== product.id);
  recent.unshift(product);
  recent = recent.slice(0, 12);
  localStorage.setItem("sokoniRecentlyViewed", JSON.stringify(recent));
}

/* Call on buyProduct so we track views */
const _origBuyProduct = window.buyProduct;

/* ==============================================
   SAVED SEARCHES
============================================== */

function saveSearch(query){
  if(!query || query.length < 2) return;
  /* Never save email addresses or phone numbers as search terms */
  if(/[@]/.test(query) || /^\+?\d{7,}$/.test(query.trim())) return;
  let saves = [];
  try { saves = JSON.parse(localStorage.getItem("sokoniSavedSearches"))||[]; } catch(e){}
  if(!saves.includes(query)){
    saves.unshift(query);
    saves = saves.slice(0, 10);
    localStorage.setItem("sokoniSavedSearches", JSON.stringify(saves));
  }
}

function renderSavedSearches(){
  const el = document.getElementById("savedSearchesList");
  if(!el) return;
  let saves = [];
  try { saves = JSON.parse(localStorage.getItem("sokoniSavedSearches"))||[]; } catch(e){}
  /* Use data-attributes to avoid injecting user search terms into onclick JS strings */
  el.innerHTML = saves.map((s,i)=>`
    <button class="saved-search-pill" data-saved-search="${_escHtml(String(s))}" data-idx="${i}">🔍 ${_escHtml(String(s))}</button>
  `).join("");
  el.querySelectorAll("[data-saved-search]").forEach(btn => {
    btn.addEventListener("click", () => {
      const inp = document.getElementById("searchInput");
      if(inp) inp.value = btn.dataset.savedSearch;
      searchProducts();
    });
  });
}

/* ==============================================
   ABANDONED CART RECOVERY
============================================== */

function checkAbandonedCart(){
  const cart = JSON.parse(localStorage.getItem("cart")||"[]");
  if(!cart.length) return;

  const lastActivity = Number(localStorage.getItem("sokoniLastActivity")||0);
  const now = Date.now();
  const minutesIdle = (now - lastActivity) / 60000;

  /* After 5 minutes idle with items in cart, send reminder */
  if(minutesIdle >= 5 && lastActivity > 0){
    const alreadyReminded = localStorage.getItem("sokoniCartReminded") === "true";
    if(!alreadyReminded){
      localStorage.setItem("sokoniCartReminded","true");
      showAbandonedCartReminder(cart.length);
    }
  }
}

function showAbandonedCartReminder(count){
  /* Browser notification */
  if("Notification" in window && Notification.permission === "granted"){
    new Notification("🛒 You left items in your cart!", {
      body: `You have ${count} item${count>1?"s":""} waiting. Complete your purchase before they sell out!`,
      icon: "/assets/logosokoni.png"
    });
  }

  /* In-app toast */
  const toast = document.createElement("div");
  toast.className = "abandoned-cart-toast";
  toast.innerHTML = `
    <div class="act-icon">🛒</div>
    <div class="act-body">
      <strong>${count} item${count>1?"s":""} in your cart!</strong>
      <p>Don't let them sell out. Complete your purchase.</p>
    </div>
    <a href="cart.html" class="act-btn">Go to Cart →</a>
    <button class="act-close" onclick="this.parentElement.remove()">✕</button>
  `;
  document.body.appendChild(toast);
  setTimeout(() => { if(toast.parentElement) toast.remove(); }, 8000);
}

/* Track user activity */
["click","keydown","scroll"].forEach(ev => {
  window.addEventListener(ev, () => {
    localStorage.setItem("sokoniLastActivity", Date.now().toString());
    localStorage.removeItem("sokoniCartReminded");
  }, { passive:true });
});

/* Check abandoned cart after page has been open 5 minutes */
setTimeout(checkAbandonedCart, 300000);
/* Also check on load if user comes back */
setTimeout(checkAbandonedCart, 3000);

window.saveSearch = saveSearch;
window.searchProducts = searchProducts;
window.filterProducts = filterProducts;
window.removeFromCart = removeFromCart;
window.toggleChat = toggleChat;
window.sendMessage = sendMessage;
window.openQuickView = openQuickView;
window.closeQuickView = closeQuickView;
window.toggleTheme = toggleTheme;

/* MOBILE MENU */

function toggleMobileMenu(){
    const mobileMenu = document.getElementById("mobileMenu");
    const overlay = document.getElementById("menuOverlay");
    if(!mobileMenu) return;
    const opening = !mobileMenu.classList.contains("active-menu");
    mobileMenu.classList.toggle("active-menu");
    if(overlay) overlay.classList.toggle("active");
    document.body.style.overflow = opening ? "hidden" : "";
}

/* Close on Escape key */
document.addEventListener("keydown", function(e){
    if(e.key === "Escape"){
        const m = document.getElementById("mobileMenu");
        if(m && m.classList.contains("active-menu")) toggleMobileMenu();
    }
});



/* GLOBAL */

window.toggleMobileMenu =

toggleMobileMenu;

/* SEARCH SUGGESTIONS */

function showSuggestions(){



    const input = document.getElementById(

        "searchInput"

    );



    const suggestions = document.getElementById(

        "searchSuggestions"

    );



    const value = input.value.toLowerCase();



    if(value === ""){

        suggestions.style.display = "none";

        return;

    }



    const filtered = products.filter(product =>

        product.name.toLowerCase()

        .includes(value)

    );



    suggestions.innerHTML = "";

    filtered.slice(0,5).forEach(product => {
        const item = document.createElement("div");
        item.className = "search-item";
        item.textContent = product.name;
        item.addEventListener("click", () => selectSuggestion(product.name));
        suggestions.appendChild(item);
    });



    suggestions.style.display = "block";

}



/* SELECT */

function selectSuggestion(productName){



    document.getElementById(

        "searchInput"

    ).value = productName;



    document.getElementById(

        "searchSuggestions"

    ).style.display = "none";



    const filtered = products.filter(product =>

        product.name === productName

    );



    displayProducts(filtered);

}



/* GLOBAL */

window.showSuggestions = showSuggestions;
window.selectSuggestion = selectSuggestion;

/* =========================
   HOMEPAGE REVIEWS TEASER
========================= */

function loadHomepageReviews(){
    const FALLBACK_REVIEWS = [
        { name:"Brian K.", rating:5, comment:"Sokoni is amazing! Got my electronics in 2 hours. Fast delivery and great prices.", date:"21 May 2026" },
        { name:"Grace W.", rating:5, comment:"Best online marketplace in Kenya. Very easy to use and the sellers are 100% legit.", date:"20 May 2026" },
        { name:"James O.", rating:4, comment:"Great platform! Bought fashion items and they were exactly as described. Shopping again!", date:"19 May 2026" },
        { name:"Fatuma A.", rating:5, comment:"Ordered medicine through Healthcare Hub — arrived in 1.5 hours. Absolutely incredible!", date:"18 May 2026" },
        { name:"Daniel M.", rating:5, comment:"Booked a DJ for my wedding through Entertainment Hub. He was phenomenal. Worth every shilling!", date:"17 May 2026" },
        { name:"Mercy A.", rating:5, comment:"Used catering for my corporate event. Chef was professional, food was incredible!", date:"27 May 2026" },
    ];
    let reviews = [];
    try { reviews = JSON.parse(localStorage.getItem("sokoniReviews")) || []; } catch(e) {}
    const platformRevs = reviews.filter(r => r.type === "platform");
    const container = document.getElementById("homepageReviews");
    const section   = document.getElementById("reviewsTeaser");
    if(!container) return;

    /* Always use the best available reviews — prefer real ones, fall back to demo */
    const display = platformRevs.length >= 3 ? platformRevs.slice(0, 6) : FALLBACK_REVIEWS;
    container.innerHTML = display.map(r => reviewCard(r)).join("");

    /* Always show the section */
    if(section) section.style.display = "flex";
}

function reviewCard(r){
    const _rn = String(r.name||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const _rc = String(r.comment||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    return `
        <div class="rt-card">
            <div class="rt-card-top">
                <div class="rt-avatar">${(_rn[0]||'?').toUpperCase()}</div>
                <div>
                    <div class="rt-name">${_rn}</div>
                    <div class="rt-stars">${"★".repeat(r.rating)}${"☆".repeat(5-r.rating)}</div>
                </div>
            </div>
            <p class="rt-comment">"${_rc}"</p>
        </div>
    `;
}

/* =========================
   SOKONI SELF-MARKETING SYSTEM
========================= */

function startSokoniMarketing(){
    /* — Welcome pop-up for first-time visitors — shown after first scroll past hero so it never blocks hero buttons — */
    const visited = localStorage.getItem("sokoniVisited");
    if(!visited){
        localStorage.setItem("sokoniVisited", "true");
        let _popShown = false;
        const _showOnScroll = () => {
            if(_popShown) return;
            if(window.scrollY > 80){
                _popShown = true;
                window.removeEventListener("scroll", _showOnScroll, {passive:true});
                showWelcomePopup();
            }
        };

        /* START THE ENGAGEMENT CLOCK ONLY ONCE THE USER CAN ACTUALLY ENGAGE.
           The intent here — "show after the first scroll past the hero" — is right, but
           the 12s fallback used to start at PAGE LOAD. On a first visit the consent modal
           is up for those first seconds, so the timer burned down while the visitor was
           reading a legal notice, not browsing. showWelcomePopup() then correctly deferred
           until consent closed and fired 600 ms later — so accepting cookies was answered
           immediately by a SECOND full-screen modal, before a single product had been seen.

           Two modals back to back is not what "after the first scroll" was meant to mean.
           Wait for consent to clear, THEN give the visitor a real 12 seconds (or a scroll)
           of actual browsing. */
        const _armEngagement = () => {
            window.addEventListener("scroll", _showOnScroll, {passive:true});
            setTimeout(() => {
                if(!_popShown){
                    _popShown = true;
                    window.removeEventListener("scroll", _showOnScroll, {passive:true});
                    showWelcomePopup();
                }
            }, 12000);
        };

        /* Gate on the STORAGE FLAG, not on the banner being in the DOM.
           Testing the DOM is racy and I shipped that bug: security.js injects the consent
           banner asynchronously, so this code ran BEFORE the banner existed, concluded
           "no consent up", and armed the 12s clock anyway — reproducing the exact
           double-modal it was meant to prevent.

           security.js shows the banner iff localStorage.sokoniPrivacyAccepted is unset, so
           that key answers "will consent appear?" deterministically, with no race. */
        const _consentSettled = () => {
            try { return !!localStorage.getItem("sokoniPrivacyAccepted"); }
            catch(e) { return true; }   /* storage blocked — do not hold the popup hostage */
        };

        if(_consentSettled()){
            _armEngagement();
        } else {
            /* Poll rather than observe: the flag is written by another script, and a
               storage write fires no DOM mutation. 400ms is imperceptible here. */
            const _wait = setInterval(() => {
                if(_consentSettled()){ clearInterval(_wait); _armEngagement(); }
            }, 400);
            /* If consent is never answered the popup never shows — the correct failure
               mode. An unanswered consent notice must not be interrupted. */
        }
    }

    /* — Exit-intent pop-up — */
    document.addEventListener("mouseleave", (e) => {
        if(e.clientY < 20 && !sessionStorage.getItem("exitShown")){
            sessionStorage.setItem("exitShown","true");
            showExitPopup();
        }
    });

    /* — Promo notification every ~40s — */
    const promos = [
        "🎉 New sellers just joined Sokoni! Browse fresh products →",
        "⚡ Flash deals are live right now! Tap to see discounts →",
        "📦 Free delivery on orders over KES 2,000 today!",
        "⭐ Earn loyalty points on every purchase — shop now!",
        "🏪 Want to earn? Sell on Sokoni for free today →",
        "💬 Chat with sellers directly — ask about any product!",
        "🌍 Ships Kenya-wide — Nairobi, Mombasa, Kisumu & more!",
    ];
    let promoIdx = 0;
    setTimeout(function promoLoop(){
        showPromoToast(promos[promoIdx % promos.length]);
        promoIdx++;
        setTimeout(promoLoop, 42000);
    }, 25000);
}

function showPromoToast(msg){
    const toast = document.createElement("div");
    toast.className = "sokoni-promo-toast";
    toast.innerHTML = `
        <div class="spt-inner">
            <img src="assets/sokoni-logo-dark.png" class="spt-logo">
            <span>${msg}</span>
            <button onclick="this.parentElement.parentElement.remove()">✕</button>
        </div>
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 7000);
}

function showWelcomePopup(){
    /* LAYER PRIORITY: consent (legally required) -> welcome -> notifications.
       Measured on real Desktop Chrome: this modal fired at ~11s while the
       privacy/cookie consent banner was still on screen and rendered over it.
       A consent notice must never be obscured. Defer until the banner is gone.

       Do NOT test offsetParent — the banner is position:fixed, for which
       offsetParent is always null. */
    /* Test VISIBILITY, not existence: the banner may be hidden rather than
       removed from the DOM, in which case getElementById still finds it and the
       observer would never fire. */
    const _consentUp = () => {
      const e = document.getElementById("_sokoniPrivacyBanner");
      if (!e) return false;
      const cs = getComputedStyle(e);
      return e.getBoundingClientRect().height > 0 &&
             cs.display !== "none" && cs.visibility !== "hidden" &&
             parseFloat(cs.opacity) > 0.05;
    };
    if (_consentUp()) {
      const _obs = new MutationObserver(() => {
        if (!_consentUp()) {
          _obs.disconnect();
          setTimeout(showWelcomePopup, 600);
        }
      });
      _obs.observe(document.body, { childList: true, subtree: true });
      return;
    }
    if (document.getElementById("welcomePopup")) return;   /* never mount twice */
    const pop = document.createElement("div");
    pop.className = "mkt-popup-overlay";
    pop.id = "welcomePopup";
    pop.innerHTML = `
        <div class="mkt-popup-box">
            <button class="mkt-close" onclick="document.getElementById('welcomePopup').remove()">✕</button>
            <img src="assets/sokoni-logo-dark.png" class="mkt-popup-logo">
            <h2>Welcome to SOKONI! 🎉</h2>
            <p>Kenya's global marketplace — buy, sell, rent, book and more.</p>
            <div class="mkt-popup-perks">
                <div class="mkt-perk"><i class="fas fa-star"></i> Earn loyalty points on every order</div>
                <div class="mkt-perk"><i class="fas fa-bolt"></i> Flash deals updated daily</div>
                <div class="mkt-perk"><i class="fas fa-truck"></i> Fast delivery across Kenya</div>
                <div class="mkt-perk"><i class="fas fa-shield-alt"></i> Secure M-Pesa payments</div>
            </div>
            <a href="signup.html" class="mkt-popup-cta">Create Free Account →</a>
            <button class="mkt-popup-skip" onclick="document.getElementById('welcomePopup').remove()">Maybe later</button>
        </div>
    `;
    document.body.appendChild(pop);
}

function showExitPopup(){
    const pop = document.createElement("div");
    pop.className = "mkt-popup-overlay";
    pop.id = "exitPopup";
    pop.innerHTML = `
        <div class="mkt-popup-box" style="border-color:rgba(255,68,0,0.3);">
            <button class="mkt-close" onclick="document.getElementById('exitPopup').remove()">✕</button>
            <div style="font-size:48px;margin-bottom:12px;">⚡</div>
            <h2>Wait! Don't miss out!</h2>
            <p>You have unseen products and deals waiting for you on Sokoni.</p>
            <div class="mkt-popup-perks">
                <div class="mkt-perk"><i class="fas fa-fire" style="color:#ff4400"></i> Flash sale ending soon</div>
                <div class="mkt-perk"><i class="fas fa-tag" style="color:#71ff00"></i> New arrivals just added</div>
            </div>
            <button class="mkt-popup-cta" onclick="document.getElementById('exitPopup').remove();window.scrollTo({top:0,behavior:'smooth'})">Take me back →</button>
            <button class="mkt-popup-skip" onclick="document.getElementById('exitPopup').remove()">Exit anyway</button>
        </div>
    `;
    document.body.appendChild(pop);
}

window.showWelcomePopup = showWelcomePopup;

function shareSOKONI(){
    const url = "https://mysokoni.co.ke";
    const text = "🛍️ Shop on SOKONI — Kenya's #1 marketplace!\nProducts, services, food, healthcare & more.\nPay with M-Pesa 👉 " + url;
    if(navigator.share){
        navigator.share({ title:"SOKONI Marketplace", text, url })
            .catch(()=>{});
    } else if(navigator.clipboard){
        navigator.clipboard.writeText(url).then(()=>{
            showNotification("Link copied! Share anywhere 🔗", "success");
        }).catch(()=>_execCopyFallback(url));
    } else {
        _execCopyFallback(url);
    }
}
function _execCopyFallback(txt){
    try {
        const el = document.createElement("textarea");
        el.value = txt; el.style.position="fixed"; el.style.opacity="0";
        document.body.appendChild(el); el.select();
        document.execCommand("copy"); el.remove();
        showNotification("Link copied! Share anywhere 🔗", "success");
    } catch(e){ showNotification("Copy: " + txt, "success"); }
}

window.shareSOKONI = shareSOKONI;
window._execCopyFallback = _execCopyFallback;

/* =========================
   AUTO-REFRESH ON NEW PRODUCTS
========================= */

window.addEventListener("storage", (e) => {
    if(e.key === "sellerProducts"){
        loadProducts();
        updateCart();
    }
});

/* ═══════════════════════════════════════════════════════════════
   SELLER STORIES — homepage display & viewer
═══════════════════════════════════════════════════════════════ */

let _activeStories  = [];
let _storyTimerID   = null;
let _storyViewIdx   = 0;
let _storyMuted     = false;   /* persists across stories in one session */
let _storyStartTime = 0;       /* when current story started (ms) */
let _storyDuration  = 5000;    /* duration of current story (ms) */
let _storyPaused    = false;

/* ── DEMO PREMIUM STORIES — always visible, curated ── */
const DEMO_PREMIUM_STORIES = [
    { id:"dp001", sellerName:"Kaspa Prints",   type:"promo", premium:true,
      bgGradient:"linear-gradient(145deg,#0d1117 0%,#1a0533 40%,#2d0a55 100%)",
      emoji:"🎨", accentColor:"#a855f7",
      caption:"50% OFF all branded merch today — tees, hoodies, caps & more!",
      ctaLabel:"Shop Merch", ctaLink:"category.html?cat=fashion",
      postedAt:Date.now()-1*3600000, expiresAt:Date.now()+23*3600000 },
    { id:"dp002", sellerName:"TechNairobi",    type:"promo", premium:true,
      bgGradient:"linear-gradient(145deg,#050d1a 0%,#0a1628 40%,#0d2137 100%)",
      emoji:"📱", accentColor:"#38bdf8",
      caption:"iPhone 15 Pro from KES 89,000 — best price in Nairobi, limited units!",
      ctaLabel:"View Deal", ctaLink:"category.html?cat=phones",
      postedAt:Date.now()-2*3600000, expiresAt:Date.now()+22*3600000 },
    { id:"dp003", sellerName:"FreshFoods KE",  type:"promo", premium:true,
      bgGradient:"linear-gradient(145deg,#051a0d 0%,#0a2d18 40%,#0d3d1e 100%)",
      emoji:"🥑", accentColor:"#4ade80",
      caption:"Fresh groceries delivered in 45 min. Order before 2 PM for same-day!",
      ctaLabel:"Order Now", ctaLink:"food.html",
      postedAt:Date.now()-3*3600000, expiresAt:Date.now()+21*3600000 },
    { id:"dp004", sellerName:"StyleHouse",     type:"promo", premium:false,
      bgGradient:"linear-gradient(145deg,#1a0510 0%,#2d0a1f 40%,#3d0f2a 100%)",
      emoji:"👗", accentColor:"#f472b6",
      caption:"New arrivals every Monday — designer looks from KES 999!",
      ctaLabel:"Browse Looks", ctaLink:"category.html?cat=fashion",
      postedAt:Date.now()-4*3600000, expiresAt:Date.now()+20*3600000 },
    { id:"dp005", sellerName:"LuxBnB Nairobi", type:"promo", premium:true,
      bgGradient:"linear-gradient(145deg,#0a1a1a 0%,#0d2d2d 40%,#0f3d3d 100%)",
      emoji:"🏨", accentColor:"#2dd4bf",
      caption:"Weekend escapes from KES 4,500/night — Nairobi, Mombasa & Nakuru",
      ctaLabel:"Book Now", ctaLink:"bnb.html",
      postedAt:Date.now()-5*3600000, expiresAt:Date.now()+19*3600000 },
    { id:"dp006", sellerName:"BuildRight KE",  type:"promo", premium:true,
      bgGradient:"linear-gradient(145deg,#1a1000 0%,#2d1c00 40%,#3d2700 100%)",
      emoji:"🏗️", accentColor:"#f59e0b",
      caption:"Pre-vetted contractors, materials & equipment — quote in 2 hrs!",
      ctaLabel:"Get a Quote", ctaLink:"construction.html?tab=rfq",
      postedAt:Date.now()-6*3600000, expiresAt:Date.now()+18*3600000 },
];

function loadStoriesSection(){
    const section = document.getElementById("storiesSection");
    const ring    = document.getElementById("storiesRing");
    if(!ring) return;

    const now  = Date.now();

    /* Real user stories from localStorage */
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem("sokoniStories")) || []; } catch(e){}
    const realActive = saved.filter(s => s.expiresAt > now);

    /* Merge: real stories first, then demo premium ones (no duplicates by id) */
    const realIds = new Set(realActive.map(s=>s.id));
    const combined = [...realActive, ...DEMO_PREMIUM_STORIES.filter(d => !realIds.has(d.id))];
    _activeStories = combined;

    /* Always show the stories section */
    if(section) section.style.display = "block";

    /* Logged-in user check */
    let user = null;
    try { user = JSON.parse(localStorage.getItem("sokoniUser")); } catch(e){}
    const isSeller = user && (user.registeredAs?.seller || user.isSeller);

    /* Group by seller for ring display */
    const bySellerMap = {};
    combined.forEach(s => {
        if(!bySellerMap[s.sellerName]) bySellerMap[s.sellerName] = s;
    });
    const grouped = Object.values(bySellerMap);

    /* "Your Story" — all users see it; non-sellers get upgrade prompt */
    const yourStoryFn = isSeller ? "openQuickStoryUpload()" : "openPremiumStoryPrompt()";
    const yourStoryHint = isSeller ? "+ Add new" : "Go Premium";
    const addBubble = `
        <div style="flex-shrink:0;cursor:pointer;text-align:center;min-width:72px;" onclick="${yourStoryFn}">
            <div style="width:68px;height:68px;border-radius:50%;background:rgba(113,255,0,0.07);border:2.5px dashed rgba(113,255,0,0.45);margin:0 auto 6px;display:flex;align-items:center;justify-content:center;position:relative;transition:transform .15s,box-shadow .15s;" onmouseover="this.style.transform='scale(1.06)';this.style.boxShadow='0 0 18px rgba(113,255,0,0.25)'" onmouseout="this.style.transform='scale(1)';this.style.boxShadow='none'">
                <i class="fas fa-camera" style="font-size:22px;color:#71ff00;"></i>
            </div>
            <div style="font-size:10px;color:rgba(255,255,255,0.7);font-weight:800;">Your Story</div>
            <div style="font-size:9px;color:rgba(113,255,0,0.6);">${yourStoryHint}</div>
        </div>`;

    ring.innerHTML = addBubble + grouped.map(s => {
        const initials = s.sellerName.split(" ").map(w=>w[0]).join("").substring(0,2).toUpperCase();
        const allS = combined.filter(x=>x.sellerName===s.sellerName);
        const firstIdx = combined.indexOf(allS[0]);
        const isPrem = !!s.premium;

        /* Ring border: gold for premium, green gradient for real sellers */
        const ringBg = isPrem
            ? "linear-gradient(135deg,#f59e0b,#fbbf24,#f59e0b)"
            : "linear-gradient(135deg,#71ff00,#00aaff,#ff9800)";

        /* Inner display: photo thumbnail or colored initial */
        const innerBg = s.bgGradient || "#111";
        const thumb = (s.type==="photo" && s.media)
            ? `<img src="${s.media}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
            : `<div style="font-size:24px;line-height:1;">${s.emoji || initials}</div>`;

        /* Premium crown badge */
        const crown = isPrem
            ? `<div style="position:absolute;bottom:-4px;right:-4px;width:20px;height:20px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#fbbf24);border:2px solid #080808;display:flex;align-items:center;justify-content:center;font-size:9px;z-index:1;">⭐</div>`
            : "";

        return `
        <div style="flex-shrink:0;cursor:pointer;text-align:center;min-width:72px;" onclick="openStoryAt(${firstIdx})">
            <div style="position:relative;width:68px;height:68px;border-radius:50%;padding:3px;background:${ringBg};margin:0 auto 6px;transition:transform .15s,box-shadow .15s;box-shadow:${isPrem ? "0 0 14px rgba(245,158,11,0.4)" : "0 0 10px rgba(113,255,0,0.2)"};" onmouseover="this.style.transform='scale(1.07)';this.style.boxShadow='${isPrem ? "0 0 22px rgba(245,158,11,0.6)" : "0 0 18px rgba(113,255,0,0.4)"}';" onmouseout="this.style.transform='scale(1)';this.style.boxShadow='${isPrem ? "0 0 14px rgba(245,158,11,0.4)" : "0 0 10px rgba(113,255,0,0.2)"}';">
                <div style="width:100%;height:100%;border-radius:50%;background:${innerBg};display:flex;align-items:center;justify-content:center;overflow:hidden;">
                    ${thumb}
                </div>
                ${crown}
            </div>
            <div style="font-size:10px;color:${isPrem ? "#fbbf24" : "rgba(255,255,255,0.8)"};font-weight:700;max-width:72px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.sellerName.split(" ")[0]}</div>
            <div style="font-size:9px;color:${isPrem ? "rgba(245,158,11,0.7)" : "rgba(113,255,0,0.6)"};">${allS.length>1 ? allS.length+" stories" : (isPrem ? "Premium" : s.type)}</div>
        </div>`;
    }).join("");

    setTimeout(updateRingNavBtns, 100);
}

/* ── Non-seller taps "Your Story" — upgrade prompt ── */
function openPremiumStoryPrompt(){
    const m = document.createElement("div");
    m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.88);backdrop-filter:blur(14px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;";
    m.innerHTML = `
    <div style="background:#111;border:1px solid rgba(245,158,11,0.35);border-radius:24px;padding:32px 28px;max-width:380px;width:100%;text-align:center;font-family:inherit;">
        <div style="font-size:44px;margin-bottom:12px;">⭐</div>
        <div style="font-size:20px;font-weight:900;color:white;margin-bottom:8px;">Go Premium Seller</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.5);line-height:1.6;margin-bottom:24px;">Post stories that reach <strong style="color:white;">thousands of shoppers</strong> — showcase products, promotions & behind-the-scenes content that auto-expires in 24h.</div>
        <div style="display:flex;gap:10px;">
            <button onclick="this.closest('div[style]').remove()" style="flex:1;padding:13px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.6);border-radius:12px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">Not now</button>
            <a href="seller.html" onclick="this.closest('div[style]').remove()" style="flex:2;padding:13px;background:linear-gradient(135deg,#f59e0b,#fbbf24);color:#000;border-radius:12px;font-size:13px;font-weight:900;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:6px;">⭐ Become a Seller</a>
        </div>
    </div>`;
    m.addEventListener("click", e => { if(e.target===m) m.remove(); });
    document.body.appendChild(m);
}
window.openPremiumStoryPrompt = openPremiumStoryPrompt;

/* ── Story media — IndexedDB for video blobs (bypasses 5MB localStorage cap) ── */
(function(){
    var _idb = null, _STORE = 'storyMedia';
    function _open(){
        return new Promise(function(res,rej){
            if(_idb){ res(_idb); return; }
            var r = indexedDB.open('sokoniStoryIDB',1);
            r.onupgradeneeded = function(e){ e.target.result.createObjectStore(_STORE); };
            r.onsuccess = function(e){ _idb = e.target.result; res(_idb); };
            r.onerror   = function(){ rej(r.error); };
        });
    }
    window._storyIDBPut = function(key,blob){
        return _open().then(function(db){
            return new Promise(function(res,rej){
                var tx = db.transaction(_STORE,'readwrite');
                tx.objectStore(_STORE).put(blob,key);
                tx.oncomplete = res; tx.onerror = function(){ rej(tx.error); };
            });
        });
    };
    window._storyIDBGet = function(key){
        return _open().then(function(db){
            return new Promise(function(res,rej){
                var tx = db.transaction(_STORE,'readonly');
                var r2 = tx.objectStore(_STORE).get(key);
                r2.onsuccess = function(){ res(r2.result||null); };
                r2.onerror   = function(){ rej(r2.error); };
            });
        });
    };
    window._storyIDBDelete = function(key){
        return _open().then(function(db){
            return new Promise(function(res,rej){
                var tx = db.transaction(_STORE,'readwrite');
                tx.objectStore(_STORE).delete(key);
                tx.oncomplete = res; tx.onerror = function(){ rej(tx.error); };
            });
        });
    };
    window._dataURLtoBlob = function(dataURL){
        var arr = dataURL.split(','), mime = arr[0].match(/:(.*?);/)[1];
        var b = atob(arr[1]), n = b.length, u = new Uint8Array(n);
        while(n--) u[n] = b.charCodeAt(n);
        return new Blob([u],{type:mime});
    };
})();

/* ── Quick story upload from homepage — camera-first like WhatsApp ── */
function openQuickStoryUpload(){
    /* Seller-only gate — checked here AND in postQuickStory as double lock */
    var _u = null;
    try { _u = JSON.parse(localStorage.getItem('sokoniUser')); } catch(e){}
    if(!_u || !_u.uid){
        (window._skToast||alert)('Please log in to post a story.');
        return;
    }
    var _isSeller = _u.isSeller || _u.role === 'seller' || _u.registeredAs === 'seller' || _u.sellerActive || _u.storeName;
    if(!_isSeller){
        (window._skToast||alert)('Only registered sellers can post stories.\n\nGo to Seller Dashboard to activate your store.');
        return;
    }
    if(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function"){
        openStoryCamera();
    } else {
        _openQSPickModal();
    }
}

/* Fallback pick modal (no camera API available) */
function _openQSPickModal(){
    let modal = document.getElementById("quickStoryModal");
    if(!modal){
        modal = document.createElement("div");
        modal.id = "quickStoryModal";
        modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.92);backdrop-filter:blur(16px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;";
        modal.innerHTML = `
        <div style="background:#111;border:1px solid rgba(113,255,0,0.2);border-radius:24px;width:100%;max-width:400px;font-family:'Segoe UI',system-ui,sans-serif;overflow:hidden;">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 20px 16px;">
                <div>
                    <div style="font-size:17px;font-weight:900;color:white;">📸 Add a Story</div>
                    <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-top:2px;">Visible to shoppers · 24 hours</div>
                </div>
                <button onclick="document.getElementById('quickStoryModal').remove()" style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.55);width:32px;height:32px;border-radius:10px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
            </div>
            <div id="qsPickRow" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 20px 16px;">
                <label style="cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px 12px;background:rgba(113,255,0,0.05);border:1.5px dashed rgba(113,255,0,0.3);border-radius:16px;gap:6px;transition:.2s;" onmouseover="this.style.background='rgba(113,255,0,0.1)'" onmouseout="this.style.background='rgba(113,255,0,0.05)'">
                    <span style="font-size:32px;">📷</span>
                    <span style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.8);">Photo</span>
                    <span style="font-size:10px;color:rgba(255,255,255,0.3);">Gallery</span>
                    <input type="file" accept="image/*" style="display:none;" onchange="handleQuickStoryFile(this,'photo')">
                </label>
                <label style="cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px 12px;background:rgba(0,170,255,0.05);border:1.5px dashed rgba(0,170,255,0.3);border-radius:16px;gap:6px;transition:.2s;" onmouseover="this.style.background='rgba(0,170,255,0.1)'" onmouseout="this.style.background='rgba(0,170,255,0.05)'">
                    <span style="font-size:32px;">🎥</span>
                    <span style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.8);">Video (≤30s)</span>
                    <span style="font-size:10px;color:rgba(255,255,255,0.3);">Gallery</span>
                    <input type="file" accept="video/*" style="display:none;" onchange="handleQuickStoryFile(this,'video')">
                </label>
            </div>
            <div id="quickStoryPreviewArea" style="display:none;position:relative;margin:0 20px 14px;">
                <div style="position:relative;width:100%;padding-top:177%;border-radius:16px;overflow:hidden;background:#000;">
                    <img id="quickStoryPreviewImg" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;" alt="">
                    <video id="quickStoryPreviewVid" muted playsinline controls style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;"></video>
                    <div id="qsPreviewLabel" style="position:absolute;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.55);padding:4px 12px;border-radius:999px;font-size:11px;color:white;font-weight:700;white-space:nowrap;display:none;"></div>
                </div>
                <button onclick="_qsChangeMedia()" style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.2);color:white;padding:5px 10px;border-radius:8px;font-size:11px;cursor:pointer;font-weight:700;backdrop-filter:blur(6px);">✕ Change</button>
            </div>
            <div style="padding:0 20px 14px;">
                <input type="text" id="quickStoryCaption" placeholder="Add a caption…"
                    style="width:100%;padding:11px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:white;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box;">
            </div>
            <div style="padding:0 20px 20px;">
                <div id="quickStoryStatus" style="font-size:12px;text-align:center;min-height:18px;margin-bottom:10px;font-weight:700;"></div>
                <div id="quickStoryPostArea" style="display:none;">
                    <button onclick="postQuickStory()" style="width:100%;padding:14px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-weight:900;border:none;border-radius:14px;cursor:pointer;font-size:14px;font-family:inherit;">
                        🚀 Post Story — Go Live
                    </button>
                </div>
                <div style="margin-top:12px;text-align:center;">
                    <a href="seller.html?tab=stories" style="font-size:11px;color:rgba(255,255,255,0.25);text-decoration:none;">Advanced editor →</a>
                </div>
            </div>
        </div>`;
        document.body.appendChild(modal);
        modal.addEventListener("click", e => { if(e.target === modal) modal.remove(); });
    } else {
        modal.style.display = "flex";
    }
}

/* "✕ Change" — close preview, re-open camera / pick flow */
function _qsChangeMedia(){
    _quickStoryFile = null; _quickStoryType = null; _quickStoryDataURL = null;
    document.getElementById("quickStoryModal")?.remove();
    openQuickStoryUpload();
}
window._qsChangeMedia = _qsChangeMedia;

let _quickStoryFile = null;
let _quickStoryType = null;
let _quickStoryVideoDuration = 0;
let _quickStoryDataURL = null;

function handleQuickStoryFile(input, type){
    const file = input.files[0];
    if(!file) return;
    _quickStoryFile = file;
    _quickStoryType = type;
    _quickStoryDataURL = null;

    const pickRow   = document.getElementById("qsPickRow");
    const previewArea = document.getElementById("quickStoryPreviewArea");
    const previewImg  = document.getElementById("quickStoryPreviewImg");
    const previewVid  = document.getElementById("quickStoryPreviewVid");
    const postArea    = document.getElementById("quickStoryPostArea");
    const status      = document.getElementById("quickStoryStatus");
    const label       = document.getElementById("qsPreviewLabel");

    status.textContent = "Loading…";
    status.style.color = "rgba(255,255,255,0.5)";

    const reader = new FileReader();
    reader.onload = function(e){
        if(type === "photo"){
            previewImg.src = e.target.result;
            previewImg.style.display = "block";
            previewVid.style.display = "none";
            if(pickRow) pickRow.style.display = "none";
            previewArea.style.display = "block";
            if(label){ label.textContent = "📷 Photo"; label.style.display = "block"; }
            postArea.style.display = "block";
            status.textContent = "✅ Ready to post!";
            status.style.color = "#71ff00";
        } else {
            previewVid.src = e.target.result;
            previewVid.style.display = "block";
            previewImg.style.display = "none";
            if(pickRow) pickRow.style.display = "none";
            previewArea.style.display = "block";
            status.textContent = "Checking video…";
            status.style.color = "rgba(255,255,255,0.5)";

            previewVid.onloadedmetadata = function(){
                const dur = previewVid.duration;
                _quickStoryVideoDuration = dur;
                if(dur > 30){
                    status.textContent = `❌ Video is ${Math.round(dur)}s — max 30s. Choose a shorter clip.`;
                    status.style.color = "#ff6b6b";
                    postArea.style.display = "none";
                    if(label){ label.textContent = `⚠️ Too long (${Math.round(dur)}s)`; label.style.display = "block"; label.style.color = "#ff6b6b"; }
                } else {
                    if(label){ label.textContent = `🎥 ${Math.round(dur)}s`; label.style.display = "block"; label.style.color = ""; }
                    postArea.style.display = "block";
                    status.textContent = "✅ Ready to post!";
                    status.style.color = "#71ff00";
                }
            };
        }
    };
    reader.readAsDataURL(file);
}

function postQuickStory(){
    if(!_quickStoryFile && !_quickStoryDataURL) return;

    /* Double-lock seller guard — prevents console bypass of openQuickStoryUpload check */
    let user = null;
    try { user = JSON.parse(localStorage.getItem("sokoniUser")); } catch(e){}
    if(!user || !user.uid){ (window._skToast||alert)('Please log in to post a story.'); return; }
    var _isSeller = user.isSeller || user.role === 'seller' || user.registeredAs === 'seller' || user.sellerActive || user.storeName;
    if(!_isSeller){ (window._skToast||alert)('Only registered sellers can post stories.'); return; }

    const status = document.getElementById("quickStoryStatus");
    const postArea = document.getElementById("quickStoryPostArea");
    status.textContent = "📤 Publishing…";
    status.style.color = "rgba(255,255,255,0.6)";
    if(postArea) postArea.style.display = "none";

    const sellerName = user.name || user.storeName || "My Store";
    const caption    = document.getElementById("quickStoryCaption")?.value.trim() || "";

    function _commitStory(obj){
        let stories = [];
        try { stories = JSON.parse(localStorage.getItem("sokoniStories")) || []; } catch(ex){}
        stories.unshift(obj);
        /* Trim payload to avoid localStorage bloat — keep max 40 stories, drop old videoSrc strings */
        stories = stories.slice(0,40);
        try {
            localStorage.setItem("sokoniStories", JSON.stringify(stories));
        } catch(e){
            /* Storage full: strip any raw videoSrc blobs and retry */
            stories.forEach(function(st){ if(st.videoSrc && st.videoSrc.length > 500) delete st.videoSrc; });
            try { localStorage.setItem("sokoniStories", JSON.stringify(stories)); } catch(e2){}
        }
        if(status){ status.textContent = "✅ Story live!"; status.style.color = "#71ff00"; }
        setTimeout(() => {
            document.getElementById("quickStoryModal")?.remove();
            loadStoriesSection();
        }, 1200);
    }

    function _buildBase(){
        return { id:"S"+Date.now(), sellerName, type:_quickStoryType, caption, ctaLink:"",
                 createdAt:Date.now(), postedAt:Date.now(), expiresAt:Date.now()+86400000 };
    }

    function _publishPhoto(dataURL){
        var obj = _buildBase();
        obj.media = dataURL; obj.videoSrc = ""; obj.videoDuration = 0;
        _commitStory(obj);
    }

    function _publishVideo(blob){
        /* Store video blob in IndexedDB — avoids 5MB localStorage crash */
        var idbKey = "story_" + Date.now();
        window._storyIDBPut(idbKey, blob).then(function(){
            var obj = _buildBase();
            obj.media = ""; obj.videoSrc = ""; obj.videoIDBKey = idbKey;
            obj.videoDuration = Math.round(_quickStoryVideoDuration);
            _commitStory(obj);
        }).catch(function(){
            /* IDB unavailable — last-resort base64 fallback (may fail on large clips) */
            var r = new FileReader();
            r.onload = function(ev){
                try {
                    var obj = _buildBase();
                    obj.media = ""; obj.videoSrc = ev.target.result;
                    obj.videoDuration = Math.round(_quickStoryVideoDuration);
                    _commitStory(obj);
                } catch(e){ (window._skToast||alert)('Video too large to save. Record a shorter clip.'); }
            };
            r.readAsDataURL(blob);
        });
    }

    if(_quickStoryType === 'video'){
        var blob = _quickStoryDataURL ? window._dataURLtoBlob(_quickStoryDataURL) : _quickStoryFile;
        _publishVideo(blob);
    } else {
        if(_quickStoryDataURL){
            _publishPhoto(_quickStoryDataURL);
        } else {
            const reader = new FileReader();
            reader.onload = e => _publishPhoto(e.target.result);
            reader.readAsDataURL(_quickStoryFile);
        }
    }
}

window.openQuickStoryUpload = openQuickStoryUpload;
window.handleQuickStoryFile = handleQuickStoryFile;
window.postQuickStory       = postQuickStory;

/* ═══════════════════════════════════════════════════════════════
   IN-APP STORY CAMERA  —  tap = photo  ·  hold = video (≤30s)
   ═══════════════════════════════════════════════════════════════ */
let _camStream      = null;
let _camRecorder    = null;
let _camChunks      = [];
let _camTimerIV     = null;
let _camRecordStart = 0;
let _camRecording   = false;
let _camShouldSave  = false;
let _camFacing      = "environment";
let _camHoldTimer   = null;

function openStoryCamera(){
    document.getElementById("storyCameraModal")?.remove();
    const m = document.createElement("div");
    m.id = "storyCameraModal";
    m.style.cssText = "position:fixed;inset:0;z-index:999999;background:#000;display:flex;flex-direction:column;touch-action:none;user-select:none;-webkit-user-select:none;";
    m.innerHTML = `
        <video id="camPreviewVid" autoplay playsinline muted
            style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"></video>

        <!-- Top bar -->
        <div style="position:absolute;top:0;left:0;right:0;z-index:10;
                    padding:max(env(safe-area-inset-top,0px),16px) 16px 16px;
                    display:flex;justify-content:space-between;align-items:center;
                    background:linear-gradient(to bottom,rgba(0,0,0,0.65),transparent);">
            <button id="camCloseBtn"
                style="width:42px;height:42px;border-radius:50%;background:rgba(0,0,0,0.45);
                       border:1px solid rgba(255,255,255,0.2);color:white;font-size:20px;
                       cursor:pointer;display:flex;align-items:center;justify-content:center;
                       backdrop-filter:blur(10px);">✕</button>
            <button id="camFlipBtn"
                style="width:42px;height:42px;border-radius:50%;background:rgba(0,0,0,0.45);
                       border:1px solid rgba(255,255,255,0.2);color:white;font-size:20px;
                       cursor:pointer;display:flex;align-items:center;justify-content:center;
                       backdrop-filter:blur(10px);">🔄</button>
        </div>

        <!-- Recording timer badge -->
        <div id="camTimer"
            style="display:none;position:absolute;top:50%;left:50%;
                   transform:translate(-50%,-160%);z-index:10;
                   background:rgba(220,38,38,0.9);padding:5px 18px;
                   border-radius:999px;color:white;font-size:13px;
                   font-weight:900;font-family:monospace;letter-spacing:.5px;">● 0:00</div>

        <!-- 30s progress ring -->
        <div id="camRingWrap"
            style="display:none;position:absolute;bottom:94px;left:50%;
                   transform:translateX(-50%);z-index:10;pointer-events:none;">
            <svg width="88" height="88" style="transform:rotate(-90deg);">
                <circle cx="44" cy="44" r="37" fill="none"
                        stroke="rgba(255,255,255,0.18)" stroke-width="5"/>
                <circle id="camRingCircle" cx="44" cy="44" r="37" fill="none"
                        stroke="#ff4040" stroke-width="5"
                        stroke-dasharray="232.5" stroke-dashoffset="232.5"/>
            </svg>
        </div>

        <!-- Bottom controls -->
        <div style="position:absolute;bottom:0;left:0;right:0;z-index:10;
                    padding:24px 28px max(env(safe-area-inset-bottom,0px),24px);
                    display:flex;align-items:center;justify-content:space-between;
                    background:linear-gradient(to top,rgba(0,0,0,0.72),transparent);">

            <!-- Gallery picker -->
            <label style="width:54px;height:54px;border-radius:14px;
                          background:rgba(255,255,255,0.14);
                          border:1px solid rgba(255,255,255,0.2);
                          display:flex;align-items:center;justify-content:center;
                          cursor:pointer;font-size:26px;backdrop-filter:blur(10px);flex-shrink:0;"
                   title="Pick from gallery">
                🖼️
                <input type="file" accept="image/*,video/*" style="display:none;" id="camGalleryInput">
            </label>

            <!-- Capture button -->
            <div style="display:flex;flex-direction:column;align-items:center;gap:8px;">
                <div id="camCaptureBtn"
                    style="width:78px;height:78px;border-radius:50%;background:white;
                           border:5px solid rgba(255,255,255,0.4);
                           cursor:pointer;transition:transform .12s,background .15s;flex-shrink:0;">
                </div>
                <div style="font-size:9px;color:rgba(255,255,255,0.45);font-weight:700;text-align:center;line-height:1.5;">
                    TAP · PHOTO<br>HOLD · VIDEO
                </div>
            </div>

            <!-- Spacer to balance layout -->
            <div style="width:54px;height:54px;flex-shrink:0;"></div>
        </div>
    `;
    document.body.appendChild(m);

    m.querySelector("#camCloseBtn").addEventListener("click", _closeCam);
    m.querySelector("#camFlipBtn").addEventListener("click",  _flipCam);
    m.querySelector("#camGalleryInput").addEventListener("change", e => _camGalleryPick(e.target));

    const capBtn = m.querySelector("#camCaptureBtn");
    capBtn.addEventListener("pointerdown",   _camPressStart);
    capBtn.addEventListener("pointerup",     _camPressEnd);
    capBtn.addEventListener("pointercancel", _camPressEnd);

    _startCamStream();
}
window.openStoryCamera = openStoryCamera;

async function _startCamStream(){
    try {
        _camStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: _camFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: true
        });
        const v = document.getElementById("camPreviewVid");
        if(v){ v.srcObject = _camStream; v.play().catch(()=>{}); }
    } catch(err){
        _closeCam();
        (window._skToast||alert)("Camera access denied or unavailable.\nPlease allow camera permission or use the gallery.");
    }
}

function _closeCam(){
    _stopCamRecord(false);
    if(_camStream){ _camStream.getTracks().forEach(t => t.stop()); _camStream = null; }
    document.getElementById("storyCameraModal")?.remove();
}
window._closeCam = _closeCam;

async function _flipCam(){
    _camFacing = _camFacing === "environment" ? "user" : "environment";
    if(_camStream){ _camStream.getTracks().forEach(t => t.stop()); _camStream = null; }
    await _startCamStream();
}
window._flipCam = _flipCam;

function _camPressStart(e){
    e.currentTarget.style.transform = "scale(0.85)";
    _camHoldTimer = setTimeout(() => _startCamRecord(), 220);
}
window._camPressStart = _camPressStart;

function _camPressEnd(e){
    e.currentTarget.style.transform = "scale(1)";
    clearTimeout(_camHoldTimer);
    if(!_camRecording){
        _captureStoryPhoto();
    } else {
        _stopCamRecord(true);
    }
}
window._camPressEnd = _camPressEnd;

function _captureStoryPhoto(){
    const v = document.getElementById("camPreviewVid");
    if(!v || !_camStream) return;
    const canvas = document.createElement("canvas");
    canvas.width  = v.videoWidth  || 1280;
    canvas.height = v.videoHeight || 720;
    canvas.getContext("2d").drawImage(v, 0, 0);
    const dataURL = canvas.toDataURL("image/jpeg", 0.92);
    _closeCam();
    _injectCapturedMedia(dataURL, "photo", 0);
}

function _startCamRecord(){
    if(!_camStream || _camRecording) return;
    _camRecording = true;
    _camChunks    = [];

    const capBtn = document.getElementById("camCaptureBtn");
    if(capBtn) capBtn.style.background = "#ff3d3d";
    const timer = document.getElementById("camTimer");
    if(timer) timer.style.display = "block";
    const ring  = document.getElementById("camRingWrap");
    if(ring) ring.style.display = "block";
    const circle = document.getElementById("camRingCircle");
    if(circle){
        requestAnimationFrame(() => {
            circle.style.transition = "stroke-dashoffset 30s linear";
            circle.style.strokeDashoffset = "0";
        });
    }

    _camRecordStart = Date.now();
    _camTimerIV = setInterval(() => {
        const secs = (Date.now() - _camRecordStart) / 1000;
        const mm = Math.floor(secs / 60);
        const ss = Math.floor(secs % 60).toString().padStart(2, "0");
        const t = document.getElementById("camTimer");
        if(t) t.textContent = `● ${mm}:${ss}`;
        if(secs >= 30) _stopCamRecord(true);
    }, 200);

    try {
        const mime = ["video/webm;codecs=vp9","video/webm","video/mp4"]
            .find(t => MediaRecorder.isTypeSupported(t)) || "";
        _camRecorder = new MediaRecorder(_camStream, mime ? { mimeType: mime } : {});
        _camRecorder.ondataavailable = e => { if(e.data && e.data.size > 0) _camChunks.push(e.data); };
        _camRecorder.onstop = () => {
            if(!_camShouldSave) return;
            const duration = Math.min((Date.now() - _camRecordStart) / 1000, 30);
            const blob = new Blob(_camChunks, { type: _camRecorder.mimeType || "video/webm" });
            const fr = new FileReader();
            fr.onload = ev => {
                _closeCam();
                _injectCapturedMedia(ev.target.result, "video", duration);
            };
            fr.readAsDataURL(blob);
        };
        _camRecorder.start(100);
    } catch(err){
        _camRecording = false;
        clearInterval(_camTimerIV);
        (window._skToast||alert)("Video recording not supported in this browser. You can still take photos.");
    }
}

function _stopCamRecord(save){
    if(!_camRecording) return;
    _camRecording  = false;
    _camShouldSave = save;
    clearInterval(_camTimerIV);
    if(_camRecorder && _camRecorder.state !== "inactive") _camRecorder.stop();
}

/* Show captured/recorded media in the preview + post modal */
function _injectCapturedMedia(dataURL, type, duration){
    _quickStoryFile         = null;
    _quickStoryDataURL      = dataURL;
    _quickStoryType         = type;
    _quickStoryVideoDuration = duration;

    _openQSPickModal();

    const pickRow     = document.getElementById("qsPickRow");
    const previewArea = document.getElementById("quickStoryPreviewArea");
    const previewImg  = document.getElementById("quickStoryPreviewImg");
    const previewVid  = document.getElementById("quickStoryPreviewVid");
    const postArea    = document.getElementById("quickStoryPostArea");
    const status      = document.getElementById("quickStoryStatus");
    const label       = document.getElementById("qsPreviewLabel");

    if(pickRow)     pickRow.style.display = "none";
    if(previewArea) previewArea.style.display = "block";

    if(type === "photo"){
        if(previewImg){ previewImg.src = dataURL; previewImg.style.display = "block"; }
        if(previewVid) previewVid.style.display = "none";
        if(label){ label.textContent = "📷 Photo"; label.style.display = "block"; label.style.color = ""; }
    } else {
        if(previewVid){ previewVid.src = dataURL; previewVid.style.display = "block"; }
        if(previewImg) previewImg.style.display = "none";
        if(label){ label.textContent = `🎥 ${Math.round(duration)}s`; label.style.display = "block"; label.style.color = ""; }
    }

    if(postArea) postArea.style.display = "block";
    if(status){ status.textContent = "✅ Ready to post!"; status.style.color = "#71ff00"; }
}

/* Gallery button inside the camera interface */
function _camGalleryPick(input){
    const file = input.files[0];
    if(!file) return;
    _quickStoryFile    = file;
    _quickStoryType    = file.type.startsWith("video/") ? "video" : "photo";
    _quickStoryDataURL = null;
    _closeCam();
    _openQSPickModal();
    handleQuickStoryFile({ files: [file] }, _quickStoryType);
}
window._camGalleryPick = _camGalleryPick;

/* ── Ring scroll navigation ── */
function scrollStoriesRing(dir){
    const ring = document.getElementById("storiesRing");
    if(!ring) return;
    ring.scrollBy({ left: dir * 200, behavior: "smooth" });
    setTimeout(updateRingNavBtns, 320);
}
window.scrollStoriesRing = scrollStoriesRing;

function updateRingNavBtns(){
    const ring = document.getElementById("storiesRing");
    if(!ring) return;
    const hasContent = ring.children.length > 0;
    const canLeft  = ring.scrollLeft > 4;
    const canRight = ring.scrollLeft < (ring.scrollWidth - ring.clientWidth - 4);
    const bL = document.getElementById("sRingBtnL"),  bR = document.getElementById("sRingBtnR");
    const nL = document.getElementById("sRingNavL"),  nR = document.getElementById("sRingNavR");
    if(bL){
        bL.style.display       = hasContent ? "inline-flex" : "none";
        bL.style.opacity       = canLeft  ? "1" : "0.35";
        bL.style.pointerEvents = canLeft  ? "auto" : "none";
    }
    if(bR){
        bR.style.display       = hasContent ? "inline-flex" : "none";
        bR.style.opacity       = canRight ? "1" : "0.35";
        bR.style.pointerEvents = canRight ? "auto" : "none";
    }
    if(nL) nL.style.display = canLeft  ? "flex" : "none";
    if(nR) nR.style.display = canRight ? "flex" : "none";
}
window.updateRingNavBtns = updateRingNavBtns;

/* ── Prev story ── */
function prevStory(){
    if(_storyViewIdx <= 0) return;
    clearTimeout(_storyTimerID);
    _storyViewIdx--;
    showCurrentStory();
}
window.prevStory = prevStory;

/* ── Update counter + prev/next button states ── */
function updateViewerNavState(){
    const counter = document.getElementById("storyCounter");
    const btnPrev = document.getElementById("storyBtnPrev");
    const total   = _activeStories.length;
    if(counter) counter.textContent = total > 1 ? `${_storyViewIdx + 1} / ${total}` : "";
    if(btnPrev){
        btnPrev.style.opacity      = _storyViewIdx > 0 ? "1" : "0.2";
        btnPrev.style.pointerEvents= _storyViewIdx > 0 ? "auto" : "none";
    }
    /* Build segmented progress bars */
    const row = document.getElementById("storyProgressRow");
    if(row && total > 0){
        if(row.children.length !== total){
            row.innerHTML = Array.from({length: total}, (_,i) =>
                `<div style="flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,0.18);overflow:hidden;"><div id="spSeg${i}" style="height:100%;background:#71ff00;width:0%;transition:width linear;"></div></div>`
            ).join("");
        }
        /* Mark past segments full, current animating, future empty */
        for(let i = 0; i < total; i++){
            const seg = document.getElementById("spSeg"+i);
            if(!seg) continue;
            if(i < _storyViewIdx){ seg.style.transition="none"; seg.style.width="100%"; }
            else if(i > _storyViewIdx){ seg.style.transition="none"; seg.style.width="0%"; }
            /* current segment is driven by showCurrentStory's duration */
        }
    }
    /* Hide old single progress bar */
    const oldBar = document.getElementById("storyProgress");
    if(oldBar) oldBar.style.display = "none";
}

function openStoryAt(idx){
    _storyViewIdx = Math.max(0, Math.min(idx, _activeStories.length - 1));
    showCurrentStory();
    document.getElementById("storyViewer").style.display = "block";
    document.body.style.overflow = "hidden";
}

function showCurrentStory(){
    const s = _activeStories[_storyViewIdx];
    if(!s){ closeStoryViewer(); return; }

    /* Increment view count */
    try {
        const all = JSON.parse(localStorage.getItem("sokoniStories")) || [];
        const entry = all.find(x=>x.id===s.id);
        if(entry){ entry.views = (entry.views||0)+1; localStorage.setItem("sokoniStories", JSON.stringify(all)); }
    } catch(e){}

    const initials = s.sellerName.split(" ").map(w=>w[0]).join("").substring(0,2).toUpperCase();
    document.getElementById("storyViewerAvatar").textContent = initials;
    document.getElementById("storyViewerName").textContent   = s.sellerName;
    const ts = s.createdAt || s.postedAt || Date.now();
    const ago = Math.round((Date.now() - ts) / 3600000);
    document.getElementById("storyViewerTime").textContent   = ago < 1 ? "just now" : `${ago}h ago`;

    const media = document.getElementById("storyViewerMedia");
    media.innerHTML = "";

    /* Hide mute button until we know type */
    const muteBtn = document.getElementById("storyMuteBtn");
    if(muteBtn) muteBtn.style.display = "none";

    let duration = 5000; /* photos: 5s like WhatsApp */
    if(s.type === "photo"){
        const img = document.createElement("img");
        img.src = s.media;
        img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
        media.appendChild(img);
    } else if(s.type === "video"){
        const vid = document.createElement("video");
        vid.muted = _storyMuted; vid.autoplay = true; vid.playsInline = true;
        vid.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
        vid.onloadedmetadata = () => {
            /* Cap at 30s — seek to 0 if somehow beyond */
            if(vid.duration > 30) vid.currentTime = 0;
            /* Update progress bar duration now we know exact length */
            const exactDur = Math.min(vid.duration, 30) * 1000;
            const seg2 = document.getElementById("spSeg" + _storyViewIdx);
            if(seg2){
                seg2.style.transition = "none"; seg2.style.width = "0%";
                requestAnimationFrame(() => {
                    seg2.style.transition = `width ${exactDur}ms linear`;
                    seg2.style.width = "100%";
                });
            }
        };
        vid.ontimeupdate = () => { if(vid.currentTime >= 30){ vid.pause(); advanceStory(); } };
        vid.onended      = () => advanceStory();
        media.appendChild(vid);
        /* Load from IndexedDB if stored there (large video blobs); fallback to data URL */
        if(s.videoIDBKey && window._storyIDBGet){
            window._storyIDBGet(s.videoIDBKey).then(function(blob){
                if(blob){
                    vid.src = URL.createObjectURL(blob);
                } else if(s.videoSrc || s.media){
                    vid.src = s.videoSrc || s.media;
                } else {
                    advanceStory();
                }
            }).catch(function(){
                if(s.videoSrc || s.media){ vid.src = s.videoSrc || s.media; }
                else advanceStory();
            });
        } else {
            vid.src = s.videoSrc || s.media;
        }
        /* Show mute button for video */
        if(muteBtn){
            muteBtn.style.display = "flex";
            muteBtn.textContent = _storyMuted ? "🔇" : "🔊";
        }
        duration = Math.min(30000, (s.videoDuration || 15) * 1000 + 200);
    } else {
        /* promo type — rich gradient card with emoji + accent */
        const _rawAcc2 = String(s.accentColor || "");
        const accent = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d,.\s%]+\)|[a-zA-Z]{2,30})$/.test(_rawAcc2.trim()) ? _rawAcc2.trim() : "#71ff00";
        /* Sanitize emoji: strip HTML tags, allow only printable non-tag chars */
        const safeEmoji = String(s.emoji||"📢").replace(/[<>"'&]/g, c => ({"<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;","&":"&amp;"}[c]));
        const bg = document.createElement("div");
        bg.style.cssText = `position:absolute;inset:0;background:${s.bgGradient||"#111"};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;`;
        bg.innerHTML = `
            <div style="font-size:90px;line-height:1;filter:drop-shadow(0 0 32px ${accent}88);animation:promoEmojiFloat 3s ease-in-out infinite;">${safeEmoji}</div>
            <div style="font-size:13px;font-weight:900;color:${accent};letter-spacing:0.12em;text-transform:uppercase;opacity:0.8;">${s.premium?"⭐ Premium Story":"Promoted"}</div>
            <div style="width:48px;height:3px;border-radius:2px;background:${accent};opacity:0.5;"></div>`;
        media.appendChild(bg);
        duration = 7000;
    }

    document.getElementById("storyViewerCaption").textContent = s.caption || "";
    const ctaEl = document.getElementById("storyViewerCta");

    if(s.ctaProductId || s.productSnapshot){
        /* Linked to a specific product — show product card that goes directly to that product */
        const snap  = s.productSnapshot || {};
        const pid   = s.ctaProductId || snap.id || "";
        const pname = snap.name  || s.ctaProductName || "View Product";
        const pprice= snap.price ? "KES " + Number(snap.price).toLocaleString() : "";
        const pimg  = snap.image || "";
        const ename = String(pname).replace(/</g,"&lt;").replace(/>/g,"&gt;");
        ctaEl.innerHTML = `
          <div data-story-pid="${_escHtml(String(pid))}" data-story-snap="${_escHtml(JSON.stringify(snap))}"
               style="background:rgba(255,255,255,0.06);border:1px solid rgba(113,255,0,0.25);border-radius:14px;
                      padding:10px 12px;display:flex;align-items:center;gap:10px;max-width:340px;cursor:pointer;
                      transition:border-color .2s;" onmouseover="this.style.borderColor='rgba(113,255,0,0.6)'"
               onmouseout="this.style.borderColor='rgba(113,255,0,0.25)'"
               onclick="(function(el){try{viewStoryProduct(el.dataset.storyPid,JSON.parse(el.dataset.storySnap))}catch(e){}})(this)">
            ${pimg ? `<img src="${pimg.replace(/"/g,"&quot;")}" alt="" style="width:44px;height:44px;border-radius:8px;object-fit:cover;flex-shrink:0;">` : '<div style="width:44px;height:44px;border-radius:8px;background:rgba(113,255,0,0.1);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">📦</div>'}
            <div style="flex:1;min-width:0;">
              <div style="font-size:11px;color:rgba(255,255,255,0.4);font-weight:700;margin-bottom:2px;">Featured Product</div>
              <div style="font-size:13px;font-weight:800;color:white;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${ename}</div>
              ${pprice ? `<div style="font-size:13px;font-weight:900;color:#71ff00;">${pprice}</div>` : ""}
            </div>
            <div style="font-size:13px;font-weight:900;color:#71ff00;flex-shrink:0;">Shop →</div>
          </div>`;
    } else if(s.ctaLink){
        const _rawLink = String(s.ctaLink).trim();
        /* Allow relative (internal) and absolute links; block javascript: protocol */
        const safeLink = /^javascript:/i.test(_rawLink) ? "#" : _rawLink.replace(/"/g,"&quot;").replace(/'/g,"&#39;");
        const label = (s.ctaLabel || "View Now").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        /* Sanitize CSS color to prevent style-attribute injection */
        const _rawAccent = String(s.accentColor || "");
        const accent = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d,.\s%]+\)|[a-zA-Z]{2,30})$/.test(_rawAccent.trim()) ? _rawAccent.trim() : "#71ff00";
        const accentDim    = accent + "33";
        const accentBorder = accent + "55";
        const accentHover  = accent + "cc";
        ctaEl.innerHTML = `<a href="${safeLink}" onclick="closeStoryViewer();"
          style="display:inline-flex;align-items:center;gap:6px;padding:11px 26px;background:${accentDim};border:1px solid ${accentBorder};
                 color:${accent};font-size:13px;font-weight:900;border-radius:12px;text-decoration:none;transition:border-color .18s,background .18s;"
          onmouseover="this.style.borderColor='${accentHover}';this.style.background='${accentDim.replace("33","55")}';"
          onmouseout="this.style.borderColor='${accentBorder}';this.style.background='${accentDim}';">${label} →</a>`;
    } else {
        ctaEl.innerHTML = "";
    }

    /* Update counter, prev/next states, segmented progress bars */
    updateViewerNavState();

    /* Animate the current segment */
    const seg = document.getElementById("spSeg" + _storyViewIdx);
    if(seg){
        seg.style.transition = "none"; seg.style.width = "0%";
        requestAnimationFrame(() => {
            seg.style.transition = `width ${duration}ms linear`;
            seg.style.width = "100%";
        });
    }

    /* Legacy single bar (hidden but kept for backward compat) */
    const bar = document.getElementById("storyProgressBar");
    if(bar){ bar.style.transition="none"; bar.style.width="0%"; }

    _storyStartTime = Date.now();
    _storyDuration  = duration;
    _storyPaused    = false;

    clearTimeout(_storyTimerID);
    if(s.type !== "video") _storyTimerID = setTimeout(advanceStory, duration);
}

function advanceStory(){
    _storyViewIdx++;
    if(_storyViewIdx >= _activeStories.length){ closeStoryViewer(); return; }
    showCurrentStory();
}

function closeStoryViewer(){
    clearTimeout(_storyTimerID);
    _storyPaused = false;
    document.getElementById("storyViewer").style.display  = "none";
    document.body.style.overflow = "";
    const muteBtn = document.getElementById("storyMuteBtn");
    if(muteBtn) muteBtn.style.display = "none";
    const bar = document.getElementById("storyProgressBar");
    if(bar){ bar.style.transition="none"; bar.style.width="0%"; }
}

/* Toggle mute on active story video */
function toggleStoryMute(){
    _storyMuted = !_storyMuted;
    const vid = document.getElementById("storyViewerMedia")?.querySelector("video");
    if(vid) vid.muted = _storyMuted;
    const btn = document.getElementById("storyMuteBtn");
    if(btn) btn.textContent = _storyMuted ? "🔇" : "🔊";
}
window.toggleStoryMute = toggleStoryMute;

/* Hold-to-pause + tap-to-navigate — WhatsApp-style */
document.addEventListener("DOMContentLoaded", () => {
    const viewer = document.getElementById("storyViewer");
    if(!viewer) return;

    let _holdTimer  = null;
    let _downX      = 0;
    let _downTime   = 0;
    let _holding    = false;

    function _pauseViewer(){
        if(_holding) return;
        _holding = true;
        _storyPaused = true;
        clearTimeout(_storyTimerID);
        const vid = document.getElementById("storyViewerMedia")?.querySelector("video");
        if(vid) vid.pause();
        /* Freeze progress bar at current width */
        const seg = document.getElementById("spSeg" + _storyViewIdx);
        if(seg){
            const w = getComputedStyle(seg).width;
            seg.style.transition = "none";
            seg.style.width = w;
        }
    }

    function _resumeViewer(){
        if(!_holding) return;
        _holding = false;
        _storyPaused = false;
        const s = _activeStories[_storyViewIdx];
        if(!s) return;
        const vid = document.getElementById("storyViewerMedia")?.querySelector("video");
        if(vid && s.type === "video"){
            vid.play();
            /* Re-arm timer for remaining video time */
            const remaining = Math.max(0, (Math.min(vid.duration, 30) - vid.currentTime) * 1000);
            if(remaining > 0) _storyTimerID = setTimeout(advanceStory, remaining + 200);
            /* Re-animate progress bar from current position to 100% */
            const seg = document.getElementById("spSeg" + _storyViewIdx);
            if(seg && remaining > 0){
                requestAnimationFrame(() => {
                    seg.style.transition = `width ${remaining}ms linear`;
                    seg.style.width = "100%";
                });
            }
        } else {
            /* Photo / promo — resume from where we paused */
            const elapsed  = Date.now() - _storyStartTime;
            const remaining = Math.max(500, _storyDuration - elapsed);
            _storyTimerID = setTimeout(advanceStory, remaining);
            const seg = document.getElementById("spSeg" + _storyViewIdx);
            if(seg && remaining > 0){
                requestAnimationFrame(() => {
                    seg.style.transition = `width ${remaining}ms linear`;
                    seg.style.width = "100%";
                });
            }
        }
    }

    viewer.addEventListener("pointerdown", e => {
        if(e.target.closest("a, button")) return;
        _downX    = e.clientX;
        _downTime = Date.now();
        _holding  = false;
        _holdTimer = setTimeout(_pauseViewer, 200);
    });

    viewer.addEventListener("pointerup", e => {
        clearTimeout(_holdTimer);
        if(_holding){
            _resumeViewer();
            return;
        }
        /* Short tap — navigate only if not a swipe */
        if(Math.abs(e.clientX - _downX) > 20) return;
        if(Date.now() - _downTime < 350){
            if(e.clientX < window.innerWidth / 2) prevStory();
            else advanceStory();
        }
    });

    viewer.addEventListener("pointercancel", () => {
        clearTimeout(_holdTimer);
        _resumeViewer();
    });

    /* Prevent context menu on long press (mobile) */
    viewer.addEventListener("contextmenu", e => e.preventDefault());
});

/* Navigate to the exact product page from a story */
function viewStoryProduct(pid, snapJSON){
    let product = null;
    /* Try live products first */
    try{
        const all = JSON.parse(localStorage.getItem("sellerProducts")||"[]");
        product = all.find(p => String(p.id) === String(pid)) || null;
    }catch(e){}
    /* Fall back to the embedded snapshot */
    if(!product && snapJSON){
        try{ product = JSON.parse(typeof snapJSON==="string" ? snapJSON : JSON.stringify(snapJSON)); }catch(e){}
    }
    if(product){
        localStorage.setItem("selectedProduct", JSON.stringify(product));
    }
    closeStoryViewer();
    /* Pass id as URL param so product.html can look it up even if localStorage is stale */
    window.location.href = "product.html?id=" + encodeURIComponent(String(pid));
}
window.viewStoryProduct  = viewStoryProduct;
window.openStoryAt       = openStoryAt;
window.closeStoryViewer  = closeStoryViewer;

/* Load on init */
if(document.readyState === "complete" || document.readyState === "interactive"){
    loadStoriesSection();
} else {
    window.addEventListener("DOMContentLoaded", loadStoriesSection);
}

/* ═══════════════════════════════════════════════════════
   SELLER BROADCAST LISTENER (buyer-side)
   Shows in-app toast when a followed seller sends a push.
═══════════════════════════════════════════════════════ */
(function initBroadcastListener(){
    const follows = (()=>{
        try{ return JSON.parse(localStorage.getItem("sokoniFollowing")||"{}"); }catch(e){ return {}; }
    })();
    const sellerNames = Object.keys(follows);
    if(!sellerNames.length) return;

    const seen    = new Set();
    const started = Date.now();
    let _broadcastUnsub = null;

    function startListening(){
        if(!window.SokoniDB || typeof window.SokoniDB.listenSellerBroadcasts !== "function") return;
        _broadcastUnsub = window.SokoniDB.listenSellerBroadcasts(sellerNames, function(broadcast){
            /* Ignore broadcasts older than 5 minutes (stale from before page load) */
            const bTime = (broadcast.createdAt && typeof broadcast.createdAt.toMillis === "function")
                ? broadcast.createdAt.toMillis()
                : (typeof broadcast.createdAt === "number" ? broadcast.createdAt : 0);
            if(bTime && bTime < started - 300000) return;
            if(seen.has(broadcast._id)) return;
            seen.add(broadcast._id);
            _showBroadcastToast(broadcast);
        });
        window.addEventListener("pagehide", function(){ if(_broadcastUnsub) _broadcastUnsub(); }, { once: true });
    }

    if(window.SokoniDB){
        startListening();
    } else {
        window.addEventListener("sokoniDbReady", startListening, { once: true });
    }

    function _showBroadcastToast(b){
        const title = (b.title || "New message from a store you follow").slice(0,60);
        const body  = (b.body  || "").slice(0,120);
        const url   = b.url   || "";
        const name  = b.sellerName || b._sellerName || "Store";

        /* Reuse existing push-toast if available */
        if(typeof showPushToast === "function"){
            showPushToast("📲 " + name, title + (body ? " — " + body : ""), "green");
            return;
        }

        const toast = document.createElement("div");
        toast.style.cssText = [
            "position:fixed;top:72px;right:12px;z-index:99999;",
            "width:min(320px,calc(100vw - 24px));",
            "background:#111;border:1px solid rgba(113,255,0,0.28);",
            "border-radius:16px;padding:14px 16px;cursor:pointer;",
            "box-shadow:0 8px 32px rgba(0,0,0,0.5);",
            "animation:bToastIn .3s cubic-bezier(.34,1.56,.64,1);",
        ].join("");
        toast.innerHTML =
            "<style>@keyframes bToastIn{from{opacity:0;transform:translateY(-12px)}to{opacity:1;transform:none}}</style>" +
            "<div style='font-size:11px;font-weight:800;color:rgba(113,255,0,0.7);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;'>📲 " + name + "</div>" +
            "<div style='font-size:13px;font-weight:700;color:white;margin-bottom:3px;'>" + title + "</div>" +
            (body ? "<div style='font-size:12px;color:rgba(255,255,255,0.5);'>" + body + "</div>" : "");
        if(url) toast.addEventListener("click", () => { location.href = url; });
        else    toast.addEventListener("click", () => toast.remove());
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity="0"; toast.style.transition="opacity .4s"; setTimeout(()=>toast.remove(),400); }, 8000);
    }
})();

/* ── Phase 9: scroll-reveal + page entrance ── */
(function(){
  /* Page fade-in on load */
  document.addEventListener('DOMContentLoaded', function(){
    document.body.classList.add('p9-page-in');

    /* Scroll reveal: watch all .p9-reveal elements */
    if (!window.IntersectionObserver) {
      document.querySelectorAll('.p9-reveal').forEach(function(el){ el.classList.add('p9-in'); });
      return;
    }
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (!entry.isIntersecting) return;
        entry.target.classList.add('p9-in');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.p9-reveal').forEach(function(el){ io.observe(el); });
  });
})();


