/* Active offers map: productId → offer (loaded once, checked per card) */
var _activeOffers = new Map();
(function () {
    function tryLoadOffers() {
        if (!window.SokoniOffers) { setTimeout(tryLoadOffers, 800); return; }
        SokoniOffers.listenActive(function (map) { _activeOffers = map; renderProducts(filtered); });
    }
    setTimeout(tryLoadOffers, 0); // defer so `filtered` is initialized before the first callback
})();

const params = new URLSearchParams(window.location.search);
const _rawCat = params.get("cat") || "all";
/* `category` is derived below, once categoryMeta exists — see the comment
   there for why this is no longer a second hand-maintained list. */
const _sortParam = params.get("sort") || "";

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }


const categoryMeta = {
    all:           { title:"All Products",        icon:"🛍️" },
    fashion:       { title:"Fashion",             icon:"👕" },
    electronics:   { title:"Electronics",        icon:"📱" },
    accessories:   { title:"Accessories",        icon:"⌚" },
    printing:      { title:"Printing",           icon:"🖨️" },
    beauty:        { title:"Beauty",             icon:"💄" },
    cars:          { title:"Cars & Autos",       icon:"🚗" },
    luxury:        { title:"Luxury",             icon:"💎" },
    food:          { title:"Food & Groceries",   icon:"🍎" },
    sports:        { title:"Sports & Fitness",   icon:"⚽" },
    health:        { title:"Health & Wellness",  icon:"💊" },
    furniture:     { title:"Home & Living",      icon:"🛋️" },
    books:         { title:"Books & Education",  icon:"📚" },
    agriculture:   { title:"Agriculture",        icon:"🌱" },
    digital:       { title:"Digital & eSoko",    icon:"💻" },
    alcohol:       { title:"18+ Products",       icon:"🔞" },
    vape:          { title:"18+ Vape",           icon:"🔞" },
    tobacco:       { title:"18+ Tobacco",        icon:"🔞" },
    services:      { title:"Services",           icon:"🛠️" },
    "phone-repair":    { title:"Phone Repair",   icon:"📱" },
    "computer-repair": { title:"IT Repair",      icon:"💻" },
    "graphic-design":  { title:"Graphic Design", icon:"🎨" },
    photography:       { title:"Photography",    icon:"📸" },
    cleaning:          { title:"Cleaning",       icon:"🧹" },
    laundry:           { title:"Mamafua / Laundry", icon:"🧺" },
    plumbing:          { title:"Plumbing",       icon:"🔧" },
    electrical:        { title:"Electrical",     icon:"⚡" },
    tutoring:          { title:"Tutoring",       icon:"📚" },
    catering:          { title:"Catering",       icon:"🍽️" },
    events:            { title:"Events",         icon:"🎉" },
    "hair-beauty":     { title:"Hair & Beauty",  icon:"💇" },

    /* Products categories missing from pills */
    shoes:      { title:"Shoes & Footwear",       icon:"👟" },
    computers:  { title:"Computers & Laptops",    icon:"💻" },
    appliances: { title:"Home Appliances",         icon:"🔌" },
    meat:       { title:"Meat & Butchery",         icon:"🥩" },
    fish:       { title:"Fish & Seafood",          icon:"🐟" },
    poultry:    { title:"Poultry & Eggs",          icon:"🐔" },
    dairy:      { title:"Dairy & Milk Products",   icon:"🥛" },
    bakery:     { title:"Bakery & Bread",          icon:"🍞" },
    adult:      { title:"Adult Lifestyle Products",icon:"🌹" },
};

/* The valid categories ARE the keys of categoryMeta. Previously a separate
   hand-written _allowedCats Set guarded this, and the two drifted: the Set
   listed 25 categories while categoryMeta defined 36. The eleven that existed
   only in the metadata — shoes, computers, appliances, furniture, meat, fish,
   poultry, dairy, bakery, agriculture, digital — are linked from category.html
   pills and index.html, so every one of those deep links silently fell through
   to unfiltered "All Products" with the wrong page title.

   Worse, it was inconsistent for the SAME url: switchCategory() never applied
   the whitelist, so clicking a pill in-page filtered correctly while reloading
   or sharing that url did not.

   Deriving the guard from the metadata removes the second list entirely, so
   adding a category in one place cannot desynchronise it again. */
const category = Object.prototype.hasOwnProperty.call(categoryMeta, _rawCat) ? _rawCat : "all";

/* Age gate for adult categories */
if(typeof isAdultCategory === "function" && isAdultCategory(category)){
    requireAgeVerification().then(verified => {
        if(!verified){ window.location.href = "/"; return; }
        /* Sync storage keys and remove any per-card blurs */
        sessionStorage.setItem('sokoniAgeVerified','true');
        localStorage.setItem('sokoniAgeVerified','true');
        /* Dismiss the simple fallback gate modal if it fired first */
        const simpleGate = document.getElementById('ageGate');
        if(simpleGate) simpleGate.style.display='none';
        document.body.style.overflow='';
        if(typeof _unblurCards === 'function') _unblurCards();
    });
}

const meta = categoryMeta[category] || categoryMeta.all;
const _sortLabels = { newest:"New Arrivals", bestselling:"Fastest Selling", discount:"Big Discounts", picks:"Today's Picks" };
const _sortLabel = _sortLabels[_sortParam] || "";
document.title = `SOKONI — ${_sortLabel || meta.title}`;
document.getElementById("catTitle").textContent = _sortLabel || meta.title;
document.getElementById("catIcon").textContent = _sortParam === "newest" ? "✨" : _sortParam === "bestselling" ? "🔥" : _sortParam === "discount" ? "🏷️" : _sortParam === "picks" ? "📅" : meta.icon;

/* Mark active pill */
document.querySelectorAll(".cat-pill").forEach(pill => {
    const href = pill.getAttribute("href");
    if(href && href.includes(`cat=${category}`)) pill.classList.add("cat-pill-active");
});

/* Load products — use fallback demo catalogue when localStorage is empty */
const DEMO_PRODUCTS = [
  { id:"D1",  name:"Samsung Galaxy A55 5G",      price:52000, category:"electronics", location:"nairobi",  sold:29,  views:312, sellerName:"Sokoni Electronics",  image:"https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400&q=70"  },
  { id:"D2",  name:"Vitenge Flare Dress",         price:3200,  category:"fashion",     location:"nairobi",  sold:45,  views:201, sellerName:"KenShop Fashion",      image:"https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?w=400&q=70"  },
  { id:"D3",  name:"Avocado Face Serum",          price:850,   category:"beauty",      location:"nairobi",  sold:82,  views:445, sellerName:"Beauty Kenya",         image:"https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=400&q=70"  },
  { id:"D4",  name:"Jordan 1 Retro High OG",     price:14500, category:"shoes",       location:"nairobi",  sold:18,  views:289, sellerName:"Sneaker Hub KE",       image:"https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400&q=70"  },
  { id:"D5",  name:"HP Pavilion 15 Laptop",       price:68000, category:"computers",   location:"nairobi",  sold:11,  views:178, sellerName:"Tech World Kenya",     image:"https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=400&q=70"  },
  { id:"D6",  name:"Kenyan Arabica Coffee 1kg",   price:1800,  category:"food",        location:"nairobi",  sold:134, views:567, sellerName:"Nyeri Highlands",      image:"https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=400&q=70"  },
  { id:"D7",  name:"Bluetooth Gaming Headset",    price:4500,  category:"electronics", location:"nairobi",  sold:37,  views:223, sellerName:"Game Zone KE",         image:"https://images.unsplash.com/photo-1612198188060-c7c2a3b66eae?w=400&q=70"  },
  { id:"D8",  name:"Men's Slim Fit Suit",         price:7800,  category:"fashion",     location:"mombasa",  sold:22,  views:198, sellerName:"Executive Wear",       image:"https://images.unsplash.com/photo-1507679799987-c73779587ccf?w=400&q=70"  },
  { id:"D9",  name:"Gym Protein Whey 2kg",        price:6500,  category:"sports",      location:"nairobi",  sold:54,  views:312, sellerName:"Fitness Pro Kenya",    image:"https://images.unsplash.com/photo-1593095948071-474c5cc2989d?w=400&q=70"  },
  { id:"D10", name:"Wooden Dining Table Set",     price:42000, category:"furniture",   location:"nairobi",  sold:8,   views:145, sellerName:"Home Décor Kenya",     image:"https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&q=70"  },
  { id:"D11", name:"Tecno Spark 20 Pro",          price:22000, category:"electronics", location:"kisumu",   sold:61,  views:390, sellerName:"Kisumu Tech Shop",     image:"https://images.unsplash.com/photo-1592750475338-74b7b21085ab?w=400&q=70"  },
  { id:"D12", name:"Woven Kiondo Handbag",        price:1200,  category:"accessories", location:"nairobi",  sold:93,  views:521, sellerName:"Maasai Crafts",        image:"https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=400&q=70"  },
  { id:"D13", name:"Nike Air Max 270",            price:9500,  category:"shoes",       location:"nairobi",  sold:34,  views:267, sellerName:"Sneaker Hub KE",       image:"https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400&q=70"  },
  { id:"D14", name:"Queen Bed Frame & Mattress",  price:38000, category:"furniture",   location:"nairobi",  sold:6,   views:112, sellerName:"Home Décor Kenya",     image:"https://images.unsplash.com/photo-1505693314120-0d443867891c?w=400&q=70"  },
  { id:"D15", name:"Sunscreen SPF 50 Daily",      price:650,   category:"beauty",      location:"nairobi",  sold:118, views:634, sellerName:"Beauty Kenya",         image:"https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=400&q=70"  },
  { id:"D16", name:"MacBook Air M2 — Silver",     price:145000,category:"computers",   location:"nairobi",  sold:5,   views:389, sellerName:"iStore Kenya",         image:"https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=400&q=70"  },
  { id:"D17", name:"Ankara Ankara Print Shirt",   price:1800,  category:"fashion",     location:"nairobi",  sold:67,  views:334, sellerName:"KenShop Fashion",      image:"https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&q=70"  },
  { id:"D18", name:"Organic Coconut Oil 1L",      price:720,   category:"food",        location:"mombasa",  sold:89,  views:412, sellerName:"Coastal Organics",     image:"https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=400&q=70"  },
  { id:"D19", name:"Leather Wallet — Brown",      price:1400,  category:"accessories", location:"nairobi",  sold:52,  views:278, sellerName:"Crafted KE",           image:"https://images.unsplash.com/photo-1548036328-c9fa89d128fa?w=400&q=70"  },
  { id:"D20", name:"Health Guard Vitamin C 1000mg",price:550,  category:"health",      location:"nairobi",  sold:203, views:891, sellerName:"Pharma Direct KE",    image:"https://images.unsplash.com/photo-1559757148-5c350d0d3c56?w=400&q=70"  },
  { id:"D21", name:"JavaScript Pro — Full Course",price:2500,  category:"digital",     location:"nairobi",  sold:44,  views:312, sellerName:"Dev Kenya Academy",    image:"https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=400&q=70"  },
  { id:"D22", name:"Luxury Perfume Gift Set",     price:4800,  category:"luxury",      location:"nairobi",  sold:16,  views:234, sellerName:"Prestige KE",          image:"https://images.unsplash.com/photo-1541643600914-78b084683702?w=400&q=70"  },
  { id:"D23", name:"Toyota Corolla 2018 KDA",     price:1650000,category:"cars",       location:"nairobi",  sold:1,   views:567, sellerName:"AutoMart Kenya",       image:"https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?w=400&q=70"  },
  { id:"D24", name:"Maize 90kg Bag — Harvest 2025",price:4200, category:"agriculture", location:"nakuru",   sold:28,  views:189, sellerName:"Farmgate Direct",      image:"https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=400&q=70"  },
  { id:"D25", name:"Encyclopaedia Britannica Set",price:5500,  category:"books",       location:"nairobi",  sold:9,   views:134, sellerName:"Books Kenya",          image:"https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400&q=70"  },
];

let allProducts = [];
try { allProducts = JSON.parse(localStorage.getItem("sellerProducts")) || []; }
catch(e) { allProducts = []; }

/* If sellers haven't added products yet, show the demo catalogue */
if(allProducts.length === 0) allProducts = DEMO_PRODUCTS;

let filtered = category === "all"
    ? allProducts
    : allProducts.filter(p => p.category && p.category.toLowerCase() === category.toLowerCase());

/* Apply sort from URL param (from home-page section "View All" buttons) */
if(_sortParam === "newest")      filtered = [...filtered].sort((a,b) => Number(b.id||0) - Number(a.id||0));
if(_sortParam === "bestselling") filtered = [...filtered].sort((a,b) => (b.sold||0) - (a.sold||0));
if(_sortParam === "discount")    filtered = [...filtered].sort((a,b) => {
    const discA = a.comparePrice > a.price ? Math.round((1 - a.price / a.comparePrice) * 100) : 0;
    const discB = b.comparePrice > b.price ? Math.round((1 - b.price / b.comparePrice) * 100) : 0;
    return discB - discA;
});
if(_sortParam === "picks") {
    const dateSeed = new Date().toISOString().slice(0,10).split("").reduce((acc,c) => acc*31+c.charCodeAt(0), 1);
    let seed = dateSeed;
    const rnd = max => { seed = (seed*1664525+1013904223)&0xffffffff; return Math.abs(seed)%max; };
    for(let i = filtered.length-1; i > 0; i--){ const j = rnd(i+1); [filtered[i],filtered[j]]=[filtered[j],filtered[i]]; }
}

document.getElementById("catCount").textContent = `${filtered.length} product${filtered.length !== 1 ? "s" : ""} found`;

/* Cart count */
const updateCartCount = () => {
    const c = JSON.parse(localStorage.getItem("cart") || "[]");
    const el = document.getElementById("catCartCount");
    if(el) el.textContent = c.length;
};
updateCartCount();

/* ── VARIANT FILTERS ────────────────────────────────────────────────────────
   Facets are derived from the products actually in view, not from a per-category
   table. That is what keeps "only show filters that make sense" true without
   maintaining a second category map: a Material filter appears in Fashion only
   when some fashion product actually declares a material, and an attribute
   nobody has filled in never renders an empty control.

   Selections are OR within an attribute (Black or White) and AND across them
   (Black AND size XL) — the behaviour shoppers expect from a facet list. */
const _variantSel = {};                     /* key → Set of chosen values */

function _variantFacets(list){
    const S = window.SokoniProductSchema;
    if (!S || typeof S.variantGroups !== 'function') return [];
    const byKey = new Map();
    list.forEach(p => {
        S.variantGroups(p).forEach(g => {
            if (!byKey.has(g.key)) byKey.set(g.key, { key: g.key, label: g.label, values: new Set() });
            const f = byKey.get(g.key);
            g.values.forEach(v => f.values.add(v));
        });
    });
    /* A single option filters nothing — every product in view already has it. */
    return [...byKey.values()]
        .map(f => ({ key: f.key, label: f.label, values: [...f.values].sort() }))
        .filter(f => f.values.length > 1);
}

function applyVariantFilters(list){
    const S = window.SokoniProductSchema;
    const keys = Object.keys(_variantSel).filter(k => _variantSel[k] && _variantSel[k].size);
    if (!keys.length || !S) return list;
    return list.filter(p => keys.every(k => {
        const have = S.variantValues(p[k]);
        return have.some(v => _variantSel[k].has(v));
    }));
}

/* The list renderProducts was last called with, before variant filtering. Using
   this rather than `filtered` means toggling a colour keeps an active sort order
   or in-category search instead of silently resetting to the whole category. */
let _variantBase = [];

function toggleVariantFilter(key, val, btn){
    if (!_variantSel[key]) _variantSel[key] = new Set();
    const set = _variantSel[key];
    if (set.has(val)) set.delete(val); else set.add(val);
    if (btn) btn.setAttribute('aria-pressed', set.has(val) ? 'true' : 'false');
    renderProducts(_variantBase);
}
window.toggleVariantFilter = toggleVariantFilter;

function clearVariantFilters(){
    Object.keys(_variantSel).forEach(k => delete _variantSel[k]);
    renderProducts(_variantBase);
}
window.clearVariantFilters = clearVariantFilters;

/* Built from the category set, never from the already-filtered subset, so
   choosing "Black" does not make every other colour disappear. */
function renderVariantFilters(baseList){
    const host = document.getElementById('catVariantFilters');
    if (!host) return;
    const facets = _variantFacets(baseList);
    if (!facets.length) { host.innerHTML = ''; host.style.display = 'none'; return; }
    host.style.display = '';

    const active = Object.keys(_variantSel).some(k => _variantSel[k] && _variantSel[k].size);
    host.innerHTML = facets.map(f =>
        '<div class="cat-vfilter-group">' +
          '<span class="cat-vfilter-label">' + _esc(f.label) + '</span>' +
          f.values.map(v => {
              const on = !!(_variantSel[f.key] && _variantSel[f.key].has(v));
              return '<button type="button" class="cat-vfilter-chip" aria-pressed="' + (on ? 'true' : 'false') + '" ' +
                     'onclick="toggleVariantFilter(this.dataset.k,this.dataset.v,this)" ' +
                     'data-k="' + _esc(f.key) + '" data-v="' + _esc(v) + '">' + _esc(v) + '</button>';
          }).join('') +
        '</div>'
    ).join('') + (active
        ? '<button type="button" class="cat-vfilter-clear" onclick="clearVariantFilters()">Clear</button>'
        : '');
}

/* RENDER */
function renderProducts(list){
    const grid = document.getElementById("catProductsGrid");
    if(!grid) return;

    /* Facets reflect the unfiltered set; the grid reflects the filtered one. */
    _variantBase = list;
    renderVariantFilters(list);
    const hadAll = list.length;
    list = applyVariantFilters(list);

    const countEl = document.getElementById("catCount");
    if (countEl) countEl.textContent = `${list.length} product${list.length !== 1 ? "s" : ""} found`;

    if(list.length === 0){
        /* "Nothing here yet" would be a lie when the category does have stock
           and a filter excluded it — offer the way back instead. */
        grid.innerHTML = hadAll > 0
          ? `
            <div style="grid-column:1/-1;text-align:center;padding:80px 20px;">
                <div style="font-size:64px;margin-bottom:20px;">🔎</div>
                <h2 style="color:white;font-size:22px;margin-bottom:10px;">No matches for these filters</h2>
                <p style="color:rgba(255,255,255,0.4);margin-bottom:28px;">${hadAll} product${hadAll !== 1 ? "s" : ""} in ${_esc(meta.title)} — try fewer options</p>
                <button type="button" onclick="clearVariantFilters()" style="padding:14px 32px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;border:none;border-radius:14px;font-weight:800;font-size:15px;font-family:inherit;cursor:pointer;">Clear filters</button>
            </div>
          `
          : `
            <div style="grid-column:1/-1;text-align:center;padding:80px 20px;">
                <div style="font-size:64px;margin-bottom:20px;">${meta.icon}</div>
                <h2 style="color:white;font-size:24px;margin-bottom:10px;">No products in ${meta.title} yet</h2>
                <p style="color:rgba(255,255,255,0.4);margin-bottom:28px;">Be the first to list something here</p>
                <a href="seller.html" style="padding:14px 32px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;border-radius:14px;text-decoration:none;font-weight:800;font-size:15px;">Start Selling</a>
            </div>
          `;
        return;
    }

    const ADULT_CATS_CAT = new Set(["vape","alcohol","tobacco","adult"]);
    grid.innerHTML = list.map(p => {
        const isAdult = ADULT_CATS_CAT.has((p.category||"").toLowerCase()) || p.ageRestricted === true;
        const adultBadge = isAdult ? `<div class="adult-card-badge" style="position:absolute;top:5px;right:5px;z-index:4;font-size:8px;font-weight:900;background:rgba(255,30,30,0.85);color:white;padding:2px 6px;border-radius:5px;">🔞 18+</div>` : "";
        const oos = p.outOfStock || (p.stock !== undefined && Number(p.stock) === 0);
        const oosOverlay = oos ? `<div class="oos-overlay" style="position:absolute;inset:0;background:rgba(0,0,0,0.52);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;color:rgba(255,255,255,0.7);letter-spacing:0.5px;text-transform:uppercase;z-index:6;border-radius:12px;">Out of Stock</div>` : "";
        const rating = (()=>{ try{ const r=JSON.parse(localStorage.getItem("sokoniRatings")||"{}")[p.id]||[]; if(!r.length) return ""; const avg=(r.reduce((s,x)=>s+x.stars,0)/r.length).toFixed(1); return `<span style="font-size:9px;color:rgba(255,193,7,0.8);font-weight:700;">★ ${avg}</span>`; }catch(e){ return ""; } })();
        const _csn = p.sellerName || '';
        const _csi = _csn ? _csn.split(' ').map(w=>w[0]||'').join('').substring(0,2).toUpperCase() : '';
        const _csc = _csn ? ['#6366f1','#f59e0b','#10b981','#e11d48','#a8ff58','#0891b2','#dc2626','#059669'][_csn.split('').reduce((a,c)=>a+c.charCodeAt(0),0)%8] : '';
        const cShopRing = _csn ? `<a class="pcard-shop-ring" href="seller-public.html?seller=${encodeURIComponent(_csn)}" onclick="event.stopPropagation()" title="Visit ${_csn.replace(/"/g,'&quot;').replace(/</g,'&lt;')}" style="background:${_csc};">${_csi}</a>` : '';
        const cardHtml = `
        <div class="product-card" style="position:relative;animation:cardFadeIn 0.35s ease;cursor:pointer;" onclick="openProductCat('${_esc(p.id)}')">
            ${adultBadge}
            ${oosOverlay}
            <div class="product-img-wrap">
                <img src="${p.image || p.imageUrl || p.thumbnail || p.photo || p.coverImage || 'assets/default-product.png'}" alt="${_esc(p.name)}" loading="lazy" decoding="async" onerror="this.src='assets/default-product.png'">
                ${cShopRing}
            </div>
            <div class="product-body">
                <h3 class="product-name">${_esc(p.name)}</h3>
                ${(function(){
                    /* Same shared summary the home grid uses — "Black • XL".
                       Empty string when the product declares no variants, so
                       pre-variant products keep their current layout exactly. */
                    const S = window.SokoniProductSchema;
                    if (!S || typeof S.variantSummary !== 'function') return '';
                    const s = S.variantSummary(p);
                    return s ? '<div class="pcard-variants">' + _esc(s) + '</div>' : '';
                })()}
                <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;margin-top:1px;">
                    ${(function(){
                        var o = _activeOffers.get(p.id);
                        if(o){
                            return '<p class="price" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">' +
                                '<span style="font-size:9px;font-weight:900;background:#ff4444;color:white;padding:1px 5px;border-radius:4px;">' + _esc(o.badgeText||'OFFER') + '</span>' +
                                '<span style="text-decoration:line-through;color:rgba(255,255,255,0.3);font-size:10px;">KES ' + Number(p.price).toLocaleString() + '</span>' +
                                '<span style="color:#71ff00;">KES ' + Number(o.offerPrice).toLocaleString() + '</span>' +
                            '</p>';
                        }
                        return '<p class="price">KES ' + Number(p.price).toLocaleString() + '</p>';
                    })()}
                    ${rating}
                </div>
                ${(function(){
                    /* The handlers addToCart / addToWishlistCat / buyNowCat have
                       existed and been exported on window since this page was
                       written — nothing ever rendered controls to reach them, so
                       category shoppers could not add to cart at all and had to
                       tap through to the product page.

                       These call those existing handlers rather than introducing
                       a fifth add-to-cart implementation. stopPropagation is
                       required because the whole card carries its own onclick to
                       open the product; without it every add would also navigate
                       away, which is the likely reason buttons were left out. */
                    const pid = _esc(p.id);
                    const dis = oos ? 'disabled' : '';
                    const btn = 'flex:1;padding:7px 0;border-radius:9px;font-size:12px;font-weight:800;'
                              + 'cursor:' + (oos ? 'not-allowed' : 'pointer') + ';font-family:inherit;'
                              + 'transition:transform .12s,opacity .12s;opacity:' + (oos ? '0.35' : '1') + ';';
                    return '<div class="pcard-actions" style="display:flex;gap:6px;margin-top:7px;">'
                      + '<button type="button" ' + dis + ' aria-label="Add ' + _esc(p.name) + ' to cart" '
                      +   'onclick="event.stopPropagation();addToCart(\'' + pid + '\')" '
                      +   'style="' + btn + 'background:#71ff00;color:#050505;border:none;">🛒 Add</button>'
                      + '<button type="button" ' + dis + ' aria-label="Save ' + _esc(p.name) + ' to wishlist" '
                      +   'onclick="event.stopPropagation();addToWishlistCat(\'' + pid + '\')" '
                      +   'style="' + btn + 'background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.22);flex:0 0 42px;">🤍</button>'
                      + '</div>'
                      /* Buy Now — for shoppers who want to purchase immediately
                         without a cart round-trip. Calls the existing buyNowCat
                         handler (checkout with just this item). */
                      + '<button type="button" ' + dis + ' aria-label="Buy ' + _esc(p.name) + ' now" '
                      +   'onclick="event.stopPropagation();buyNowCat(\'' + pid + '\')" '
                      +   'style="' + btn + 'width:100%;margin-top:6px;background:linear-gradient(135deg,#71ff00,#4fc800);color:#050505;border:none;">⚡ Buy Now</button>';
                })()}
            </div>
        </div>
        `;
        if(typeof ageGateWrap === "function") return ageGateWrap(cardHtml, isAdult);
        return cardHtml;
    }).join("");
}

renderProducts(filtered);

/* OPEN PRODUCT — whole-card tap */
function openProductCat(id){
    const p = allProducts.find(x => x.id === id);
    if(!p) return;
    localStorage.setItem("selectedProduct", JSON.stringify(p));
    window.location.href = "product.html";
}
window.openProductCat = openProductCat;

/* SORT */
function sortProducts(type, btn){
    document.querySelectorAll(".cat-filter-btn").forEach(b => b.classList.remove("active-filter"));
    if(btn) btn.classList.add("active-filter");
    let sorted = [...filtered];
    if(type === "low")     sorted.sort((a,b) => Number(a.price) - Number(b.price));
    if(type === "high")    sorted.sort((a,b) => Number(b.price) - Number(a.price));
    if(type === "popular") sorted.sort((a,b) => (Number(b.views||0)+Number(b.sold||0)) - (Number(a.views||0)+Number(a.sold||0)));
    renderProducts(sorted);
}

/* ── CATEGORY PILLS — LEFT/RIGHT ARROW SCROLL ── */
(function initPillArrows(){
  const rail  = document.getElementById("pillsScroll");
  const left  = document.getElementById("arrowLeft");
  const right = document.getElementById("arrowRight");
  if(!rail || !left || !right) return;

  const STEP = 220; /* px per click */

  function updateArrows(){
    const atStart = rail.scrollLeft <= 4;
    const atEnd   = rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 4;
    left.classList.toggle("hidden",  atStart);
    right.classList.toggle("hidden", atEnd);
  }

  window.scrollPills = function(dir){
    rail.scrollBy({ left: dir * STEP, behavior:"smooth" });
  };

  rail.addEventListener("scroll", updateArrows, { passive:true });
  /* Also update on resize */
  window.addEventListener("resize", updateArrows, { passive:true });

  /* Scroll active pill into view on load */
  const active = rail.querySelector(".cat-pill-active");
  if(active) setTimeout(()=>{ active.scrollIntoView({ behavior:"smooth", inline:"center", block:"nearest" }); }, 200);

  updateArrows();
})();

/* SEARCH */
/* Debounced: oninput fires on every keystroke, and _runCatSearch re-renders
   the whole product grid — doing that per keystroke is what made typing lag on
   a large catalogue. Coalesce to one render ~160ms after the user pauses, the
   same pattern the header search (220ms) and seller product search (250ms) use.
   The input stays fully responsive; only the expensive filter+render is
   throttled. */
let _catSearchT = null;
function searchCatProducts(){
    clearTimeout(_catSearchT);
    _catSearchT = setTimeout(_runCatSearch, 160);
}
function _runCatSearch(){
    const el = document.getElementById("catSearch");
    if(!el) return;
    const val = el.value.toLowerCase();
    const results = filtered.filter(p => p.name.toLowerCase().includes(val));
    renderProducts(results);
    const cnt = document.getElementById("catCount");
    if(cnt) cnt.textContent = `${results.length} product${results.length !== 1 ? "s" : ""} found`;
}

/* NOTIFICATION */
function showNotif(msg, type){
    const c = document.getElementById("notificationContainer");
    if(!c) return;
    const n = document.createElement("div");
    n.className = `notification ${type}`;
    n.textContent = msg;
    c.appendChild(n);
    setTimeout(() => n.remove(), 3000);
}

/* Persist through the platform's single synchronisation signal.

   This page wrote localStorage directly and called its own updateCartCount(),
   which only reaches badges on this page. The header pip is owned by
   shared-header.js and listens for sokoni:cart-changed, so a category add
   updated the cart correctly and left the header stale — the same defect
   package 2 fixed everywhere else. Routing through here means the category
   page needs no knowledge of which widgets exist. */
function _saveCatCart(arr){
  try { localStorage.setItem("cart", JSON.stringify(arr)); }
  catch (e) { console.error("[SOKONI] Could not save cart: " + e.message); return false; }
  try { window.dispatchEvent(new CustomEvent("sokoni:cart-changed", { detail: { count: arr.length } })); } catch (_) {}
  return true;
}

/* CART */
async function addToCart(id){
    const product = allProducts.find(p => String(p.id) === String(id));
    if(!product) return;

    if(typeof isAdultCategory === "function" && isAdultCategory(product.category)){
        if(typeof requireAgeVerification === "function"){
            const ok = await requireAgeVerification();
            if(!ok) return;
        }
    }

    const cartData = JSON.parse(localStorage.getItem("cart") || "[]");
    /* Match marketplace behaviour: adding the same product twice is a no-op
       rather than a second line item. market-actions.js has always done this;
       this path did not, so a double tap produced duplicate rows. */
    if (cartData.some(c => String(c.id) === String(product.id))) {
        showNotif("Already in cart 🛒", "info");
        return;
    }
    cartData.push(product);
    _saveCatCart(cartData);
    updateCartCount();
    showNotif("Added to cart 🛒", "success");
    try {
        const { getFunctions, httpsCallable } = await import("https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js");
        httpsCallable(getFunctions(undefined, "us-central1"), "recordFunnelEvent")({
            step: "addToCart", category: product.category || null
        }).catch(() => {});
    } catch(_) {}
}

/* WISHLIST */
async function addToWishlistCat(id){
    const product = allProducts.find(p => String(p.id) === String(id));
    if(!product) return;

    if(typeof isAdultCategory === "function" && isAdultCategory(product.category)){
        if(typeof requireAgeVerification === "function"){
            const ok = await requireAgeVerification();
            if(!ok) return;
        }
    }

    const wishData = JSON.parse(localStorage.getItem("wishlist") || "[]");
    if(wishData.find(p => p.id === product.id)){
        showNotif("Already in wishlist ❤️", "success");
        return;
    }
    wishData.push(product);
    localStorage.setItem("wishlist", JSON.stringify(wishData));
    showNotif("Added to wishlist ❤️", "success");
}

/* BUY NOW */
async function buyNowCat(id){
    const product = allProducts.find(p => String(p.id) === String(id));
    if(!product) return;

    if(typeof isAdultCategory === "function" && isAdultCategory(product.category)){
        if(typeof requireAgeVerification === "function"){
            const ok = await requireAgeVerification();
            if(!ok) return;
        }
    }

    const cartData = JSON.parse(localStorage.getItem("cart") || "[]");
    cartData.push(product);
    localStorage.setItem("cart", JSON.stringify(cartData));
    window.location.href = "checkout.html";
}

window.sortProducts    = sortProducts;
window.searchCatProducts = searchCatProducts;
window.addToCart       = addToCart;
window.addToWishlistCat = addToWishlistCat;
window.buyNowCat       = buyNowCat;

/* ── CATEGORY SWITCH — filter in-place, no page reload ── */
function switchCategory(cat) {
    const m = categoryMeta[cat] || categoryMeta.all;

    /* Update URL silently */
    history.pushState({ cat }, '', 'category.html?cat=' + cat);

    /* Update header */
    const titleEl = document.getElementById('catTitle');
    const iconEl  = document.getElementById('catIcon');
    const countEl = document.getElementById('catCount');
    if (titleEl) titleEl.textContent = m.title;
    if (iconEl)  iconEl.textContent  = m.icon;
    document.title = 'SOKONI — ' + m.title;

    /* Rebuild filtered set and re-render */
    filtered = cat === 'all'
        ? allProducts
        : allProducts.filter(p => p.category && p.category.toLowerCase() === cat.toLowerCase());

    if (countEl) countEl.textContent = filtered.length + ' product' + (filtered.length !== 1 ? 's' : '') + ' found';
    renderProducts(filtered);

    /* Update active pill highlight */
    document.querySelectorAll('.cat-pill').forEach(p => {
        const h   = p.getAttribute('href') || '';
        const active = h.includes('cat=' + cat);
        p.classList.toggle('cat-pill-active', active);
        p.style.background  = active ? 'rgba(113,255,0,0.1)' : '';
        p.style.borderColor = active ? 'rgba(113,255,0,0.3)' : '';
        p.style.color       = active ? '#71ff00' : '';
    });

    /* Scroll active pill into view in the rail */
    const activePill = document.querySelector('.cat-pill-active');
    if (activePill) activePill.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });

    /* Scroll to the product grid */
    setTimeout(() => {
        const grid = document.getElementById('catProductsGrid');
        if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
}
window.switchCategory = switchCategory;

/* Intercept every pill that targets category.html?cat=... */
document.querySelectorAll('.cat-pill').forEach(pill => {
    const href = pill.getAttribute('href') || '';
    const m = href.match(/[?&]cat=([^&]+)/);
    if (!m) return; /* mechanics.html, food.html etc — let them navigate normally */
    pill.addEventListener('click', e => {
        e.preventDefault();
        switchCategory(m[1]);
    });
});

/* Browser back / forward */
window.addEventListener('popstate', e => {
    const cat = (e.state && e.state.cat) || new URLSearchParams(location.search).get('cat') || 'all';
    switchCategory(cat);
});

/* ── Firestore bridge ──
   Module script in category.html calls this after Firestore products load.
   Merges real products in, removes DEMO_PRODUCTS stubs, re-renders. */
window._catMergeFirestore = function(fsProducts) {
    if (!fsProducts || !fsProducts.length) return;
    const fsIds = new Set(fsProducts.map(p => String(p.id)));
    /* Keep local-only products (not yet synced to FS) */
    const localOnly = allProducts.filter(p =>
        !DEMO_PRODUCTS.some(d => d.id === p.id) && !fsIds.has(String(p.id))
    );
    allProducts = [...fsProducts, ...localOnly];
    /* Persist merged set to localStorage so future loads are fast */
    try { localStorage.setItem('sellerProducts', JSON.stringify(allProducts)); } catch(e) {}
    /* Re-render current category view */
    const currentCat = new URLSearchParams(location.search).get('cat') || 'all';
    const countEl = document.getElementById('catCount');
    let refiltered = currentCat === 'all'
        ? allProducts
        : allProducts.filter(p => p.category && p.category.toLowerCase() === currentCat.toLowerCase());
    if (countEl) countEl.textContent = refiltered.length + ' product' + (refiltered.length !== 1 ? 's' : '') + ' found';
    renderProducts(refiltered);
};
