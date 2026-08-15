/* Resolve product: prefer URL ?id= param, fall back to localStorage */
const _urlId = new URLSearchParams(window.location.search).get("id");
let product = null;
try{ product = JSON.parse(localStorage.getItem("selectedProduct")); }catch(e){}
/* If URL has a specific id that doesn't match the cached product, search sellerProducts */
if(_urlId && String(product?.id) !== String(_urlId)){
    try{
        const _all = JSON.parse(localStorage.getItem("sellerProducts")||"[]");
        const _found = _all.find(p => String(p.id) === String(_urlId));
        if(_found){ product = _found; localStorage.setItem("selectedProduct", JSON.stringify(_found)); }
    }catch(e){}
}

/* ── Firestore fallback ────────────────────────────────────────────────────
   Until now this page resolved the product ONLY from localStorage — selectedProduct
   (seeded by openProduct on a feed tap) then the seller's own sellerProducts. Any
   arrival with a ?id the device had not already cached could not resolve and fell
   straight to "Product Not Found": search results, recommendations, category pages,
   shared links, deep links, QR codes, a fresh session, another device. Firestore is
   the canonical source; fetch the product document by id, cache it, and let the
   existing synchronous render run on reload. Only a genuine miss (or an offline
   failure) reaches the Not Found state now. */
var _prdFetching = false;
/* Why the lookup failed, so the user is told the truth rather than "not found"
   for a product that exists. Empty until a failure occurs. */
var _prdLoadError = '';
if(_urlId && String(product && product.id) !== String(_urlId)){
    product = null;                 /* never render a stale / mismatched cached product */
    _prdFetching = true;
    (async function(){
        try{
            /* Wait for the app's App-Check'd Firestore (window.firebaseDB). A fresh
               import + getFirestore() issues the read BEFORE App Check has obtained a
               reCAPTCHA token — especially in a fresh/incognito session with no cached
               token — which Firestore rejects as permission-denied, so a public product
               (rules: read if true) renders as "not found". Wait for the app instance
               and the App-Check ready signal, then read via window.firebaseDB. */
            var _wt = 0;
            while(!window.firebaseDB && _wt++ < 80){ await new Promise(function(r){ setTimeout(r,150); }); }
            if(window.__sokoniAppCheckReady && typeof window.__sokoniAppCheckReady.then === 'function'){ try{ await window.__sokoniAppCheckReady; }catch(_){} }
            var _m   = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
            var _db  = window.firebaseDB || _m.getFirestore();
            var _snap = await _m.getDoc(_m.doc(_db, 'products', String(_urlId)));
            if(_snap.exists()){
                localStorage.setItem('selectedProduct', JSON.stringify(Object.assign({ id: _snap.id }, _snap.data())));
                location.reload();  /* the synchronous path above now resolves it from cache */
                return;
            }
        }catch(e){
            /* Do NOT swallow this. The catch previously discarded the error and
               fell through to "Product Not Found", so a product that exists and
               is active was reported to the user as missing. Observed in
               production: an anonymous read of products/{id} returns
               `permission-denied`, and every uncached arrival — a shared link, a
               refresh, a search result, a category deep-link — rendered
               "Product Not Found" for a live product.

               A permissions failure and a genuinely absent product are different
               conditions and must not present identically. */
            _prdLoadError = (e && e.code) ? String(e.code) : 'unavailable';
            try{ console.error('[product] lookup failed for', _urlId, '-', _prdLoadError, e && e.message); }catch(_){}
        }
        /* Every source failed. Replace the skeleton with an accurate message. */
        try{
            var _denied = _prdLoadError === 'permission-denied';
            var _msg = _denied
                ? 'We couldn’t load this product'
                : 'Product Not Found &#128546;';
            var _sub = _denied
                ? 'This is a temporary problem on our side, not a missing product. Please try again, or browse from the home page.'
                : 'This item may have been removed or is no longer available.';
            var _c = document.getElementById('productPageContainer');
            if(_c) _c.innerHTML =
                '<div style="text-align:center;padding:80px 24px;">'
              + '<h1 style="color:white;font-size:20px;margin:0 0 10px;">' + _msg + '</h1>'
              + '<p style="color:rgba(255,255,255,0.45);font-size:13px;line-height:1.6;max-width:320px;margin:0 auto 22px;">' + _sub + '</p>'
              + '<a href="/" style="display:inline-block;padding:12px 26px;background:linear-gradient(135deg,#71ff00,#4fc800);color:#000;font-weight:900;border-radius:12px;text-decoration:none;font-size:13px;">Browse Products</a>'
              + '</div>';
            var _sk = document.getElementById('productSkeleton'); if(_sk) _sk.remove();
        }catch(_){}
    })();
}

/* Set page title, meta and JSON-LD dynamically */
if(product){
    document.title = `${product.name} — KES ${Number(product.price).toLocaleString()} | SOKONI`;
    const metaDesc = document.querySelector("meta[name='description']");
    if(metaDesc) metaDesc.content = product.description || `Buy ${product.name} on SOKONI — Kenya's #1 marketplace. Fast delivery, secure payments.`;
    /* OG tags */
    const _setMeta = (prop, val) => { const el = document.querySelector(`meta[property="${prop}"]`); if(el) el.content = val; };
    _setMeta('og:title', `${product.name} — KES ${Number(product.price).toLocaleString()} | SOKONI`);
    _setMeta('og:description', product.description || `Buy ${product.name} on SOKONI — fast delivery, secure payment, verified seller.`);
    if(product.image) _setMeta('og:image', product.image);
    /* JSON-LD */
    const ldEl = document.getElementById('productJsonLd');
    if(ldEl) ldEl.textContent = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        "name": product.name,
        "description": product.description || '',
        "image": product.image || 'https://mysokoni.co.ke/assets/logosokoni.png',
        "sku": product.id || '',
        "brand": {"@type":"Brand","name": product.sellerName || 'SOKONI Seller'},
        "offers": {
            "@type": "Offer",
            "priceCurrency": "KES",
            "price": product.price || 0,
            "availability": "https://schema.org/InStock",
            "url": `https://mysokoni.co.ke/product.html?id=${product.id || ''}`,
            "seller": {"@type":"Organization","name": product.sellerName || 'SOKONI'}
        }
    });
}

/* ── Category-aware variant selector ── */
window._selectedSize  = null;
window._selectedColor = null;

function _sizeOptionsHTML(label, options) {
  return '<div class="product-option"><h3>' + label + '</h3><div class="sizes">' +
    options.map(function(s) {
      return '<button class="size-opt-btn" onclick="selectProductSize(this)">' + s + '</button>';
    }).join('') +
  '</div></div>';
}

/* ── Seller-declared variants ───────────────────────────────────────────────
   Rendered from what the seller actually saved through sokoni-product-schema.js.
   Labels and group order come from that schema, so this page cannot describe an
   attribute differently from the form that captured it.

   This displaces the old behaviour of *guessing*: every clothing item used to be
   offered XS–3XL because a regex matched the word "shirt", which presented a
   guess as stock. A seller who carries only M and L now says so and only that is
   offered. The guesswork survives below as a fallback for products saved before
   variants existed — never in preference to a declared value. ─────────────── */

var _VARIANT_LABELS = {
  colors: 'Colour', sizes: 'Size', storage: 'Storage',
  weights: 'Pack size', volumes: 'Volume', materials: 'Material',
};

/* A colour NAME is not a reliable CSS colour: "Multicolour" and "Beige" render
   as transparent, which the previous swatch used directly as a background and
   drew as an invisible circle. Known names map to hex; anything unmapped falls
   back to a neutral chip that still reads its name as text. */
var _COLOR_HEX = {
  black:'#111111', white:'#ffffff', grey:'#8a8a8a', gray:'#8a8a8a', navy:'#1b2a4a',
  blue:'#2563eb', red:'#dc2626', green:'#16a34a', yellow:'#eab308', orange:'#ea580c',
  pink:'#ec4899', purple:'#7c3aed', brown:'#78350f', beige:'#e3d5b8',
  gold:'#c9a227', silver:'#c0c0c0',
  multicolour:'linear-gradient(135deg,#dc2626,#eab308,#16a34a,#2563eb,#7c3aed)',
  multicolor:'linear-gradient(135deg,#dc2626,#eab308,#16a34a,#2563eb,#7c3aed)',
};

function _pvEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Grouping and normalisation live in the schema module, not here — a second
   copy is how the upload and edit forms drifted in the first place. If the
   schema fails to load, this returns nothing and the legacy category fallback
   below takes over, which degrades to the previous behaviour rather than an
   error. Labels are titled for display: the schema's form labels are plural
   ("Colours"), which reads wrong above a single chosen value. */
function _variantGroups(prod) {
  var S = window.SokoniProductSchema;
  if (!S || typeof S.variantGroups !== 'function') return [];
  return S.variantGroups(prod).map(function (g) {
    return { key: g.key, label: _VARIANT_LABELS[g.key] || g.label || g.key, values: g.values };
  });
}

function _variantGroupHTML(g, autoSelect) {
  var chips = g.values.map(function (v, i) {
    var on  = (autoSelect && i === 0) ? 'true' : 'false';
    var dot = '';
    if (g.key === 'colors') {
      var hex = _COLOR_HEX[v.toLowerCase()];
      dot = '<span class="sk-pvar-dot" style="background:' +
            (hex || 'rgba(255,255,255,0.25)') + '"></span>';
    }
    return '<button type="button" class="sk-pvar-chip" data-vkey="' + _pvEsc(g.key) +
           '" data-vval="' + _pvEsc(v) + '" aria-pressed="' + on + '">' +
           dot + _pvEsc(v) + '</button>';
  }).join('');
  return '<div class="product-option sk-pvar-group" data-vgroup="' + _pvEsc(g.key) + '">' +
           '<h3>' + _pvEsc(g.label) + '</h3>' +
           '<div class="sk-pvar-chips">' + chips + '</div>' +
         '</div>';
}

function getVariantHTML(prod) {
  var catRaw  = (prod.category || '') + ' ' + (prod.name || '') + ' ' + (prod.description || '');
  var cat     = catRaw.toLowerCase();
  var html    = '';

  _pvarEnsureStyles();
  window._selectedVariants = {};
  window._selectedSize     = null;
  window._selectedColor    = null;
  window._primaryVariantKey = null;

  /* 1 — Everything the seller declared, each attribute exactly once. An empty
         attribute produces no group, so no heading appears without values. */
  var groups = _variantGroups(prod);
  if (groups.length) {
    /* The first non-colour group is what the order's legacy `selectedSize`
       field mirrors — "256GB" for a phone, "M" for a shirt. Chosen before any
       preselection runs so the mirror is already pointed at the right group. */
    groups.forEach(function (g) {
      if (g.key !== 'colors' && !window._primaryVariantKey) window._primaryVariantKey = g.key;
    });
    groups.forEach(function (g) {
      /* Preselect only when there is a single option: with several, an implicit
         first choice is a choice the shopper did not make. */
      var autoSelect = g.values.length === 1;
      if (autoSelect) _setSelectedVariant(g.key, g.values[0]);
      html += _variantGroupHTML(g, autoSelect);
    });
    return html;
  }

  /* 2 — Legacy free-form variants list, kept for products that predate the schema */
  if (prod.variants && prod.variants.length) {
    if (prod.variants[0]) window._selectedSize = prod.variants[0];
    return html + _sizeOptionsHTML('Select Variant', prod.variants);
  }

  /* 3 — Category-based defaults (fallback only: nothing was declared) */
  var isCloth = /\b(shirt|tshirt|t-shirt|blouse|dress|skirt|jacket|hoodie|sweater|jumper|coat|trouser|pant|jean|short|legging|suit|fashion|cloth|wear|apparel|cap|hat|beanie|scarf|glove|underwear|lingerie|swimwear|romper|kaftan|kanzu|kanga|kitenge)\b/.test(cat);
  var isShoe  = /\b(shoe|boot|sandal|sneaker|slipper|footwear|heel|loafer|trainer|pump|moccasin)\b/.test(cat);
  var isPhone = /\b(phone|smartphone|iphone|android|laptop|tablet|ipad|computer|pc|desktop|tv|television|camera|headphone|earphone|earbuds|speaker|smartwatch|gadget|electronics|tech)\b/.test(cat);
  var isFood  = /\b(food|drink|juice|soda|beer|wine|snack|chips|biscuit|bread|cake|meal|grocery|groceries|fruit|vegetable|meat|fish|rice|flour|oil|sauce|beverage|water|coffee|tea|milk|yoghurt|chocolate|sugar|salt|dairy|millet|ugali|chapati|mandazi|samosa|pilau)\b/.test(cat);

  if (isCloth) {
    var sizes = ['XS','S','M','L','XL','XXL','3XL'];
    window._selectedSize = null;
    return html + _sizeOptionsHTML('Select Size', sizes);
  }
  if (isShoe) {
    var sizes = ['36','37','38','39','40','41','42','43','44','45','46'];
    window._selectedSize = null;
    return html + _sizeOptionsHTML('Select Size (EU)', sizes);
  }
  if (isPhone) {
    var specHtml = '';
    if (prod.specs && prod.specs.length) {
      specHtml = '<div class="product-option"><h3>Key Specs</h3>' +
        '<div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:6px;">' +
          prod.specs.map(function(s) {
            return '<span style="padding:5px 13px;background:rgba(255,255,255,0.05);' +
              'border:1px solid rgba(255,255,255,0.1);border-radius:8px;font-size:11px;' +
              'color:rgba(255,255,255,0.65);">' + s + '</span>';
          }).join('') +
        '</div></div>';
    }
    return html + specHtml; /* No size for electronics */
  }
  if (isFood) {
    var sizes = ['Single','Pack of 3','Pack of 6','Pack of 12','Bulk Box'];
    window._selectedSize = null;
    return html + _sizeOptionsHTML('Pack Size', sizes);
  }

  /* 5 — Nothing matched → return empty (quantity only) */
  return html;
}

/* Records a chosen variant and mirrors it onto the two legacy globals the cart
   and order payloads already read, so nothing downstream needs to change to
   keep working. */
function _setSelectedVariant(key, val) {
  window._selectedVariants = window._selectedVariants || {};
  window._selectedVariants[key] = val;
  if (key === 'colors') window._selectedColor = val;
  else if (key === window._primaryVariantKey || !window._primaryVariantKey) window._selectedSize = val;
}

/* One delegated listener rather than an onclick per chip: variant values are
   stored strings, and interpolating them into an inline handler is the
   js-handler injection context this codebase is removing. data-* carries them
   safely and the browser hands back the decoded value. */
function _pvarInit() {
  document.addEventListener('click', function (e) {
    var chip = e.target && e.target.closest ? e.target.closest('.sk-pvar-chip') : null;
    if (!chip) return;
    var group = chip.closest('.sk-pvar-group');
    if (!group) return;
    var all = group.querySelectorAll('.sk-pvar-chip');
    for (var i = 0; i < all.length; i++) all[i].setAttribute('aria-pressed', 'false');
    chip.setAttribute('aria-pressed', 'true');
    _setSelectedVariant(chip.getAttribute('data-vkey'), chip.getAttribute('data-vval'));
  });
}

/* The renderer ships its own styles, for the same reason the seller-side schema
   does: a second page adopting these chips must not have to remember to copy a
   stylesheet. Injected once. */
function _pvarEnsureStyles() {
  if (typeof document === 'undefined' || document.getElementById('sk-pvar-css')) return;
  var s = document.createElement('style');
  s.id = 'sk-pvar-css';
  s.textContent =
    '.sk-pvar-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}' +
    '.sk-pvar-chip{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;' +
      'background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);' +
      'border-radius:10px;color:rgba(255,255,255,0.78);font-size:13px;font-weight:600;' +
      'cursor:pointer;transition:border-color .18s,background .18s,color .18s;' +
      'min-height:38px;line-height:1}' +
    '.sk-pvar-chip:hover{border-color:rgba(113,255,0,0.45);color:#fff}' +
    '.sk-pvar-chip[aria-pressed="true"]{background:rgba(113,255,0,0.12);border-color:#71ff00;color:#71ff00}' +
    '.sk-pvar-dot{width:14px;height:14px;border-radius:50%;flex-shrink:0;' +
      'border:1px solid rgba(255,255,255,0.28);display:inline-block}';
  (document.head || document.documentElement).appendChild(s);
}

if (typeof document !== 'undefined') _pvarInit();

function selectProductSize(btn) {
  var parent = btn.closest ? btn.closest('.sizes') : btn.parentNode;
  if (parent) {
    var all = parent.querySelectorAll ? parent.querySelectorAll('.size-opt-btn') : [];
    for (var i = 0; i < all.length; i++) {
      all[i].style.background   = '';
      all[i].style.color        = '';
      all[i].style.borderColor  = '';
    }
  }
  btn.style.background  = '#71ff00';
  btn.style.color       = '#000';
  btn.style.borderColor = '#71ff00';
  window._selectedSize  = btn.textContent.trim();
}

function selectProductColor(btn, clr) {
  var parent = btn.closest ? btn.closest('.sizes') : btn.parentNode;
  if (parent) {
    var all = parent.querySelectorAll ? parent.querySelectorAll('.color-swatch') : [];
    for (var i = 0; i < all.length; i++) {
      all[i].style.borderColor = 'rgba(255,255,255,0.18)';
    }
  }
  btn.style.borderColor  = '#71ff00';
  window._selectedColor  = clr;
}

window.selectProductSize  = selectProductSize;
window.selectProductColor = selectProductColor;

/* In-page toast notification */
function _showProductNotif(msg, type){
    let nc = document.getElementById("notificationContainer");
    if(!nc){
        nc = document.createElement("div");
        nc.id = "notificationContainer";
        document.body.appendChild(nc);
    }
    const n = document.createElement("div");
    n.className = `notification ${type}`;
    n.textContent = msg;
    nc.appendChild(n);
    setTimeout(() => n.remove(), 3000);
}



/* CONTAINER */

const container = document.getElementById(

    "productPageContainer"

);



/* SAFETY CHECK */

var _skEl = document.getElementById('productSkeleton');
/* Keep the skeleton up while the Firestore fallback resolves the id — it reloads
   on success or reveals Not Found on failure. Removing it here would flash
   "Product Not Found" for a product that very likely exists. */
if(!_prdFetching && _skEl) _skEl.remove();

if(_prdFetching){
    /* The async Firestore fallback owns the outcome for this id. Do nothing. */
}
else if(!product){

    container.innerHTML = `

        <h1 style="color:white;text-align:center;padding:100px;">

            Product Not Found 😢

        </h1>

    `;

}



/* PRODUCT PAGE */

else{

    container.innerHTML = `

        <div class="premium-product-view">

            <!-- LEFT — GALLERY v2 -->
           <div class="premium-product-gallery">
            ${(()=>{
                const allMedia = [];
                if (product.videoUrl) allMedia.push({ type:'video', src: product.videoUrl });
                const _picked = (window.pickProductImage ? pickProductImage(product) : '');
                const imgs = (product.images && product.images.length)
                  ? product.images
                  : (product.imageStorageUrls && product.imageStorageUrls.length)
                    ? product.imageStorageUrls
                    : (_picked ? [_picked] : (product.image ? [product.image] : ['assets/default-product.png']));
                imgs.forEach(i => allMedia.push({ type:'image', src: i }));
                const first = allMedia[0];
                const thumbsHtml = allMedia.map((m, idx) =>
                  `<div class="prd-thumb ${idx===0?'active':''} ${m.type==='video'?'prd-video-thumb':''}" data-idx="${idx}" onclick="_prdGalleryGo(${idx})">`+
                    (m.type==='video'
                      ? `<video src="${m.src}" style="width:100%;height:100%;object-fit:cover;" muted playsinline></video>`
                      : `<img src="${m.src}" alt="" loading="lazy" onerror="this.onerror=null;this.src='assets/default-product.png'">`)+
                  `</div>`
                ).join('');
                const dotsHtml = allMedia.length > 1
                  ? `<div class="prd-gallery-dots">${allMedia.map((_,i)=>`<div class="prd-gallery-dot${i===0?' active':''}" onclick="_prdGalleryGo(${i})"></div>`).join('')}</div>`
                  : '';
                const navHtml = allMedia.length > 1
                  ? `<button class="prd-gallery-nav prev" onclick="event.stopPropagation();_prdGalleryPrev()" aria-label="Previous">&#x2039;</button><button class="prd-gallery-nav next" onclick="event.stopPropagation();_prdGalleryNext()" aria-label="Next">&#x203a;</button>`
                  : '';
                return `<div class="prd-gallery-wrap" id="prdGalleryWrap">
                  <div class="prd-gallery-main" id="prdGalleryMain" onclick="_prdLightboxOpen()" title="Tap to enlarge">
                    ${first.type==='video'
                      ? `<video id="prdMainVid" src="${first.src}" controls muted playsinline style="width:100%;height:100%;object-fit:contain;"></video>`
                      : `<img id="prdMainImg" src="${first.src}" alt="${(product.name||'').replace(/"/g,'&quot;')}" onerror="this.onerror=null;this.src='assets/default-product.png'">`}
                    ${navHtml}
                    <div class="prd-gallery-zoom-hint">Tap to zoom</div>
                  </div>
                  ${dotsHtml}
                  <div class="prd-thumb-strip">${thumbsHtml}</div>
                </div>`;
            })()}
           </div>

            <!-- RIGHT -->

            <div class="premium-product-info">

                <!-- Trending badge — populated with real data by sokoni-product-analytics.js -->
                <div id="prdTrendingBadge"></div>

                <!-- URGENCY SOCIAL PROOF — real data injected by sokoni-product-analytics.js -->
                <div class="prd-urgency-bar" id="prdUrgencyBar" aria-live="polite">
                  <span class="prd-urgency-viewers">&#x1F441; <strong id="prdViewerCount">—</strong> viewed today</span>
                  <span class="prd-urgency-sep" aria-hidden="true">·</span>
                  <span class="prd-urgency-sold">&#x1F6D2; <strong id="prdSoldCount">—</strong> sold</span>
                  <span class="prd-urgency-sep" aria-hidden="true">·</span>
                  <span class="prd-urgency-fresh">&#x1F552; <strong>Fast dispatch</strong></span>
                </div>

                <!-- ANALYTICS BADGES (views / sold / trending) -->
                <div id="prdAnalyticsBar"></div>

                <h1>${(product.name||'').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</h1>

                <!-- Seller card v2 -->
                ${(product.sellerName || product.sellerUid) ? `
                <a href="store.html?id=${product.sellerUid||product.sellerId||''}" class="prd-seller-card" id="prdSellerCard">
                    <div class="prd-seller-avatar" id="prdSellerAvatar">&#x1F3EA;</div>
                    <div class="prd-seller-info">
                        <div class="prd-seller-name" id="prdSellerName">${(product.sellerName||'View Store').replace(/</g,'&lt;')}</div>
                        <div class="prd-seller-meta">
                            <span class="prd-seller-chip verified" id="sellerVerifiedBadge" style="display:none;">&#x2705; Verified</span>
                            <span class="prd-seller-chip rating" id="prdSellerRating" style="display:none;"></span>
                            <span class="prd-seller-chip location" id="prdSellerLoc" style="display:none;"></span>
                            <span class="prd-seller-chip response-time" id="prdSellerResponseTime" style="display:none;"></span>
                        </div>
                    </div>
                    <span class="prd-seller-arrow">&#x203a;</span>
                </a>` : ''}

                ${product.kebsCert
                    ? `<div style="display:inline-flex;align-items:center;gap:7px;padding:5px 13px;background:rgba(0,180,100,0.12);border:1px solid rgba(0,200,120,0.35);border-radius:10px;margin-bottom:8px;">
                        <span style="font-size:15px;">🏅</span>
                        <div>
                            <div style="font-size:11px;font-weight:900;color:#00c864;letter-spacing:0.3px;">KEBS CERTIFIED</div>
                            <div style="font-size:10px;color:rgba(0,200,120,0.65);font-weight:600;">${product.kebsCert}</div>
                        </div>
                    </div>`
                    : (["food","agriculture","electronics","computers","appliances","health","beauty"].includes((product.category||"").toLowerCase())
                        ? `<div style="display:inline-flex;align-items:center;gap:7px;padding:5px 13px;background:rgba(255,152,0,0.08);border:1px solid rgba(255,152,0,0.25);border-radius:10px;margin-bottom:8px;">
                            <span style="font-size:15px;">⚠️</span>
                            <div style="font-size:11px;font-weight:700;color:#ff9800;">KEBS Certification Not Provided</div>
                        </div>`
                        : "")
                }

                <h2 id="productPriceEl">

                    KES ${Number(product.price).toLocaleString()}

                </h2>

                ${product.wholesalePrice && product.minWholesaleQty ? `
                <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:6px 0 4px;padding:12px 16px;background:rgba(0,170,255,0.07);border:1px solid rgba(0,170,255,0.2);border-radius:12px;">
                    <span style="font-size:11px;font-weight:800;background:rgba(0,170,255,0.15);color:#00aaff;padding:3px 10px;border-radius:20px;">🏷️ BULK DEAL</span>
                    <div>
                        <div style="font-size:13px;color:rgba(255,255,255,0.5);">Retail: <span style="color:white;font-weight:700;">KES ${Number(product.price).toLocaleString()}</span> / unit</div>
                        <div style="font-size:14px;color:#00aaff;font-weight:800;">Wholesale: KES ${Number(product.wholesalePrice).toLocaleString()} / unit <span style="font-size:11px;color:rgba(255,255,255,0.4);font-weight:400;">(min. ${product.minWholesaleQty} units)</span></div>
                    </div>
                </div>` : ""}

                <p class="premium-description">

                    ${product.description || "Premium quality product from Sokoni marketplace. Designed for style, comfort and reliability."}

                </p>



                <!-- VARIANTS (category-aware) -->
                ${getVariantHTML(product)}

                <!-- QUANTITY -->

                <div class="product-option">

                    <h3>Quantity</h3>

                    

                    <div class="quantity-box">

                        <button onclick="decreaseQty()">

                            -

                        </button>



                        <span id="qty">

                            1

                        </span>



                        <button onclick="increaseQty()">

                            +

                        </button>

                    </div>

                </div>



                <!-- TRUST STRIP -->
                <div class="prd-trust-strip" id="prdTrustStrip">
                    <div class="prd-trust-item" id="prdTrustVerified" style="display:none;"><span class="ti-icon">&#x2705;</span> Verified Seller</div>
                    <div class="prd-trust-item green"><span class="ti-icon">&#x1F512;</span> Secure Payment</div>
                    <div class="prd-trust-item"><span class="ti-icon">&#x1F6E1;&#xFE0F;</span> Buyer Protection</div>
                    <div class="prd-trust-item"><span class="ti-icon">&#x1F4E6;</span> Fast Delivery</div>
                </div>

                <!-- DELIVERY + STOCK -->
                ${(()=>{
                    var stock = product.stock != null ? Number(product.stock) : null;
                    var chipClass = 'in-stock', chipText = '&#x2714; In Stock';
                    if (stock !== null) {
                        if (stock <= 0) { chipClass = 'out-of-stock'; chipText = '&#x2716; Out of Stock'; }
                        else if (stock <= 5) { chipClass = 'low-stock'; chipText = '&#x26A0; Only ' + stock + ' left'; }
                    }
                    var _dDays = (product.location||'').toLowerCase().includes('nairobi')||
                                 (product.county||'').toLowerCase().includes('nairobi') ? 1 : 2;
                    var _dDate = new Date(); _dDate.setDate(_dDate.getDate() + _dDays);
                    /* skip Sunday */
                    if (_dDate.getDay() === 0) _dDate.setDate(_dDate.getDate() + 1);
                    var _dStr = _dDate.toLocaleDateString('en-KE',{weekday:'short',day:'numeric',month:'short'});
                    var deliveryCopy = product.deliveryTime
                        ? 'Est. delivery: ' + product.deliveryTime
                        : 'Get it by <strong style="color:#71ff00;">' + _dStr + '</strong>'
                          + (product.location||product.county ? ' · Ships from ' + (product.location||product.county) : '');
                    return `<div class="prd-delivery-bar" id="prdDeliveryBar">
                    <span class="dv-icon">&#x1F6F5;</span>
                    <span id="prdDeliveryEst">${deliveryCopy}</span>
                    <span class="prd-stock-chip ${chipClass}" id="prdStockChip" style="margin-left:auto;">${chipText}</span>
                </div>`;
                })()}

                <!-- ACTIONS — Premium CTA v2 -->
                <div id="prdActions" style="margin-top:16px;">
                    <button class="prd-cta-primary" onclick="buyNowProduct()">&#x26A1; Buy Now</button>
                    <div class="prd-cta-row">
                        <button class="prd-cta-secondary" onclick="addToCart()">&#x1F6D2; Add to Cart</button>
                        <button onclick="openMakeOffer()" class="prd-cta-secondary" style="flex:0 0 auto;padding:14px 16px;">&#x1F3F7;&#xFE0F; Offer</button>
                    </div>
                    <div class="prd-cta-row" style="margin-top:8px;">
                        <button class="prd-cta-icon-btn whatsapp" id="prdWaBtn" onclick="contactSellerGated()">
                            &#x1F4AC; Chat Seller
                        </button>
                        <button class="prd-cta-icon-btn wishlist" onclick="addToWishlistProduct()">&#x2764;&#xFE0F; Save</button>
                        <button class="prd-cta-icon-btn share" onclick="(function(){var url=window.SokoniReferral?SokoniReferral.getShareURL(window.location.href):window.location.href;if(window.SokoniSocial&&product)SokoniSocial.openShareModal({id:product.id||'p',name:product.name||'Product',category:product.category||'',tagline:product.description||'',rating:product.rating||5,type:'product',shareURL:url});else if(navigator.share)navigator.share({title:product&&product.name||'SOKONI',url:url}).catch(function(){});else window.open('https://wa.me/?text='+encodeURIComponent((product&&product.name||'Check this out')+' on SOKONI: '+url),'_blank');})()">&#x1F4E4; Share</button>
                    </div>
                </div>

                <!-- MAKE AN OFFER PANEL -->
                <div id="offerPanel" style="display:none;margin-top:14px;background:rgba(255,152,0,0.06);border:1px solid rgba(255,152,0,0.2);border-radius:14px;padding:16px;">
                    <div style="font-size:14px;font-weight:800;color:white;margin-bottom:8px;">&#x1F3F7;&#xFE0F; Make an Offer</div>
                    <div style="font-size:12px;color:rgba(255,255,255,0.45);margin-bottom:10px;">Listed at <strong style="color:#71ff00;">KES ${Number(product.price).toLocaleString()}</strong> — offer the seller a price.</div>
                    <input type="number" id="offerPrice" placeholder="Your offer price (KES)" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:10px;color:white;font-size:14px;outline:none;font-family:inherit;margin-bottom:8px;">
                    <input type="text" id="offerMsg" placeholder="Message to seller (optional)" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:10px;color:white;font-size:13px;outline:none;font-family:inherit;margin-bottom:10px;">
                    <button onclick="submitOffer()" style="padding:11px 24px;background:linear-gradient(135deg,#ff9800,#e06000);color:white;font-weight:800;border:none;border-radius:10px;cursor:pointer;font-size:13px;font-family:inherit;">&#x1F4E4; Send Offer</button>
                    <div id="offerConfirm" style="margin-top:8px;font-size:12px;"></div>
                </div>

                <!-- FEATURES -->

                <div class="product-features">

                    <p>✔ Premium Quality</p>

                    <p>✔ Fast Delivery</p>

                    <p>✔ Trusted Seller</p>

                    <p>✔ Secure Payments</p>

                </div>

                <!-- SELLER PERFORMANCE — populated by sokoni-product-analytics.js -->
                <div id="prdSellerPerfSlot"></div>

                <!-- BUYER TRUST PANEL — populated by sokoni-product-analytics.js -->
                <div id="prdTrustPanel"></div>

            </div>

        </div>

        <!-- PRICE HISTORY — populated by sokoni-product-analytics.js from Firestore -->
        <div id="prdPriceHistorySlot"></div>

        <!-- Q&A SECTION -->
        <div style="margin:24px 0;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:18px;padding:24px;" id="qaSection">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:10px;">
                <div style="font-size:16px;font-weight:800;color:white;">❓ Questions & Answers</div>
                <span style="font-size:12px;color:rgba(255,255,255,0.4);" id="qaCount">Loading...</span>
            </div>
            <div id="qaList" style="margin-bottom:20px;"></div>
            <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.09);border-radius:14px;padding:18px;">
                <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.6);margin-bottom:10px;">Ask the seller a question</div>
                <input id="qaNameInput" type="text" placeholder="Your name (optional)" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;margin-bottom:10px;font-family:inherit;">
                <textarea id="qaInput" rows="2" placeholder="Type your question..." style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;resize:none;font-family:inherit;margin-bottom:10px;"></textarea>
                <button onclick="submitQuestion()" style="padding:12px 24px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-weight:800;border:none;border-radius:10px;cursor:pointer;font-size:13px;font-family:inherit;">Ask Question</button>
            </div>
        </div>

        <!-- PRODUCT VIDEO -->
        ${product.video ? `
        <div style="margin:24px 0;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:18px;padding:24px;">
          <div style="font-size:16px;font-weight:800;color:white;margin-bottom:14px;">🎬 Product Video</div>
          <video id="productVideoEl" src="${product.video}" controls style="width:100%;border-radius:14px;max-height:340px;background:#000;" preload="metadata"></video>
          <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;">
            <button onclick="downloadProductVideo(false)" style="padding:11px 18px;background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.25);color:#71ff00;font-weight:700;border-radius:10px;cursor:pointer;font-size:13px;font-family:inherit;display:flex;align-items:center;gap:7px;">
              <i class="fas fa-download"></i> Download Original
            </button>
            <button onclick="downloadProductVideo(true)" id="compressBtn" style="padding:11px 18px;background:rgba(0,170,255,0.08);border:1px solid rgba(0,170,255,0.2);color:#00aaff;font-weight:700;border-radius:10px;cursor:pointer;font-size:13px;font-family:inherit;display:flex;align-items:center;gap:7px;">
              <i class="fas fa-compress-alt"></i> Compress &amp; Download
            </button>
          </div>
          <div id="videoDownloadStatus" style="margin-top:10px;font-size:12px;color:rgba(255,255,255,0.4);min-height:18px;"></div>
        </div>
        ` : ""}

        <!-- LIVE COMMENTS -->
        <div style="margin:24px 0;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:18px;padding:24px;" id="liveCommentsSection">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:10px;">
            <div style="font-size:16px;font-weight:800;color:white;">💬 Live Comments</div>
            <span style="font-size:12px;color:rgba(255,255,255,0.4);" id="commentCount">Loading...</span>
          </div>
          <div id="liveCommentsList" style="margin-bottom:20px;max-height:420px;overflow-y:auto;"></div>
          <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.09);border-radius:14px;padding:18px;">
            <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.6);margin-bottom:10px;">Add a public comment</div>
            <input id="commentName" type="text" placeholder="Your name (optional)" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;margin-bottom:10px;font-family:inherit;box-sizing:border-box;">
            <textarea id="commentText" rows="2" placeholder="Share your thoughts about this product…" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;resize:none;font-family:inherit;margin-bottom:10px;box-sizing:border-box;"></textarea>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
              <button onclick="postComment()" style="padding:12px 24px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-weight:800;border:none;border-radius:10px;cursor:pointer;font-size:13px;font-family:inherit;">💬 Post Comment</button>
              <span style="font-size:11px;color:rgba(255,255,255,0.3);">Visible to all buyers — not private</span>
            </div>
          </div>
        </div>

        <!-- REVIEWS -->

        <div class="reviews-section">

            <h2>

                Customer Reviews

            </h2>



            <div class="review-card">

                <div class="review-top">

                    ⭐⭐⭐⭐⭐

                </div>



                <p>

                    Amazing quality and fast delivery.

                    Definitely buying again 😄🔥

                </p>



                <span>

                    — Alex

                </span>

            </div>



            <div class="review-card">

                <div class="review-top">

                    ⭐⭐⭐⭐☆

                </div>



                <p>

                    Premium hoodie quality.

                    Sokoni is becoming elite 🔥

                </p>



                <span>

                    — Brian

                </span>

            </div>

        </div>

        <!-- SPECS -->
        ${product.specs && product.specs.length ? `
        <div class="prd-specs-section" id="prdSpecsSection">
            <div class="prd-specs-title">&#x1F4CB; Specifications</div>
            <table class="prd-specs-table">
                ${product.specs.map(s=>`<tr><td>${(s.key||'').replace(/</g,'&lt;')}</td><td>${(s.value||'').replace(/</g,'&lt;')}</td></tr>`).join('')}
            </table>
        </div>` : ''}

        <!-- RECENTLY VIEWED -->
        <div class="prd-rv-section" id="prdRvSection" style="display:none;">
            <div class="prd-rv-header">
                <div class="prd-rv-dot"></div>
                <span>Recently Viewed</span>
            </div>
            <div class="prd-rv-strip" id="prdRvStrip"></div>
        </div>

        <!-- YOU MAY LIKE -->
        <div class="yml-section" id="youMayLikeSection">
            <div class="yml-header">
                <div class="yml-title-row">
                    <span class="yml-dot"></span>
                    <h2 class="yml-title">You May Also Like</h2>
                </div>
                <a href="category.html?cat=${product.category||'all'}" class="yml-see-all">See All &#x2192;</a>
            </div>
            <div class="yml-grid" id="relatedProductsGrid">
                <div style="color:rgba(255,255,255,0.25);padding:20px;font-size:12px;">Loading&#x2026;</div>
            </div>
        </div>

    `;

    /* ── Verification badge + seller rating: Firestore is authority ── */
    (async function _checkSellerTrust(){
        var sellerUid  = product.sellerUid || product.sellerId;
        var sellerName = product.sellerName || '';
        if(!sellerUid && !sellerName) return;
        /* Expose seller uid so sokoni-verifications.js can badge the name element */
        if(sellerUid) window._productSellerUid = sellerUid;
        try {
            var {initializeApp,getApps} = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
            var {getFirestore,doc,getDoc,collection,query,where,getDocs,limit} = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
            var cfg = {apiKey:"AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE",authDomain: "auth.mysokoni.co.ke",
              projectId:"sokoni-aeb26",storageBucket:"sokoni-aeb26.firebasestorage.app",
              messagingSenderId:"24799054989",appId:"1:24799054989:web:e1cf6ca8c281bf1abf26c4",
              measurementId:"G-QT32H65TJS"};
            var app = getApps().length?getApps()[0]:initializeApp(cfg);
            var db  = getFirestore(app);

            /* Verification badge */
            /* Reads the public projection. The old getDoc on verifications/
               was owner-or-admin only, so a shopper always got PERMISSION_DENIED
               and the badge silently never showed. */
            var isVerified = false;
            if(sellerUid){
                var _vr = await fetch('/profile/' + encodeURIComponent(sellerUid) + '?format=json',
                                      { credentials: 'omit' }).catch(function(){ return null; });
                var _vp = (_vr && _vr.ok) ? await _vr.json().catch(function(){ return null; }) : null;
                isVerified = !!(_vp && _vp.found && _vp.verifiedTypes && _vp.verifiedTypes.length);
                var badge = document.getElementById('sellerVerifiedBadge');
                if(badge && isVerified) badge.style.display = '';
                var trustBadge = document.getElementById('prdTrustVerified');
                if(trustBadge && isVerified) trustBadge.style.display = '';
            }

            /* Check premium status for WhatsApp gating */
            if(sellerUid){
                try {
                    var subSnap = await getDoc(doc(db,'subscriptions',sellerUid));
                    var subData = subSnap.exists() ? subSnap.data() : {};
                    var isPremium = subData.status === 'active' && (subData.planId||'').indexOf('free') === -1;
                    window._prdSellerIsPremium = isPremium;
                    window._prdSellerPhone    = subData.phone || product.sellerPhone || '';
                    window._prdSellerWhatsApp = subData.whatsapp || product.sellerWhatsApp || '';
                    /* Update Chat button label */
                    var waBtn = document.getElementById('prdWaBtn');
                    if(waBtn && isPremium) waBtn.innerHTML = '&#x1F4AC; WhatsApp Seller';
                } catch(_){}
            }

            /* Seller rating from ratings collection */
            var rQuery = sellerUid
                ? query(collection(db,'ratings'), where('sellerUid','==',sellerUid), limit(200))
                : query(collection(db,'ratings'), where('sellerName','==',sellerName), limit(200));
            var rSnap = await getDocs(rQuery);
            if(!rSnap.empty){
                var total = 0, count = 0;
                rSnap.forEach(function(d){ var s = d.data().avgScore||d.data().stars||d.data().rating||0; if(s){total+=s;count++;} });
                if(count > 0){
                    var avg = (total/count).toFixed(1);
                    var stars = '★'.repeat(Math.round(total/count)) + '☆'.repeat(5-Math.round(total/count));
                    var ratingEl = document.getElementById('prdSellerRating');
                    if(ratingEl){ ratingEl.textContent = stars + ' ' + avg; ratingEl.style.display = ''; }
                }
            }

            /* Seller location from sellers/shops collection */
            if(sellerUid){
                try {
                    var shopSnap = await getDoc(doc(db,'shops',sellerUid));
                    if(!shopSnap.exists()) shopSnap = await getDoc(doc(db,'sellers',sellerUid));
                    if(shopSnap.exists()){
                        var sd = shopSnap.data();
                        var loc = sd.location || sd.county || sd.city || '';
                        if(loc){
                            var locEl = document.getElementById('prdSellerLoc');
                            if(locEl){ locEl.textContent = '📍 ' + loc; locEl.style.display = ''; }
                        }
                        if(sd.logoUrl || sd.logo){
                            var avEl = document.getElementById('prdSellerAvatar');
                            if(avEl){
                                var logoImg = document.createElement('img');
                                logoImg.src = sd.logoUrl || sd.logo;
                                logoImg.alt = '';
                                avEl.textContent = '';
                                avEl.appendChild(logoImg);
                            }
                        }
                        var rt = sd.responseTime || sd.avgResponseTime || '';
                        if(!rt){
                            var joined = sd.createdAt ? Date.now() - sd.createdAt.toMillis?.() : 0;
                            rt = joined > 1000*60*60*24*180 ? 'Replies in ~1h' : 'Replies in ~3h';
                        }
                        var rtEl = document.getElementById('prdSellerResponseTime');
                        if(rtEl){ rtEl.textContent = '⚡ ' + rt; rtEl.style.display = ''; }
                    }
                } catch(_){}
            }

        } catch(e){ /* silent */ }
    })();

    /* ── Active offer check ── */
    (async function () {
        try {
            if (!window.SokoniOffers) return;
            var pid = new URLSearchParams(location.search).get('id') || (product && product.id);
            if (!pid) return;
            var offer = await SokoniOffers.getActiveOffer(String(pid));
            if (!offer) return;
            var priceEl = document.getElementById('productPriceEl');
            if (priceEl) SokoniOffers.applyBadge(priceEl, offer);
        } catch(e) { /* silent — offer display is non-critical */ }
    })();

    /* ── Trust & Analytics module ── */
    (function() {
        if (typeof window.SokoniProductAnalytics === 'undefined') return;
        var pid = new URLSearchParams(location.search).get('id') || (product && product.id);
        var sid = product && (product.sellerUid || product.sellerId);
        if (!pid) return;
        window.SokoniProductAnalytics.init(String(pid), sid || null, product || null);
    })();

}



/* QUANTITY */

let quantity = 1;

/* Max purchasable = declared stock (Infinity if the product does not track stock). */
function _prdMaxStock(){
    var s = (typeof product !== 'undefined' && product && product.stock != null) ? Number(product.stock) : null;
    return (s != null && !isNaN(s)) ? s : Infinity;
}
/* Single source that updates the #qty label AND the sticky bar's live total. */
function _syncQtyUI(){
    var q = document.getElementById("qty"); if (q) q.innerText = quantity;
    if (typeof _updateStickyPrice === "function") _updateStickyPrice();
}

function increaseQty(){
    var max = _prdMaxStock();
    if (quantity < max) { quantity++; _syncQtyUI(); }
    else if (max !== Infinity) {                 /* graceful stock limit */
        try { if (window.showToast) showToast("Only " + max + " in stock", "info"); } catch(_) {}
    }
}



/* ── YOU MAY LIKE — premium compact grid ── */
function renderRelatedProducts(){
    const section = document.getElementById("youMayLikeSection");
    const grid    = document.getElementById("relatedProductsGrid");
    if(!grid || !product) return;

    let all = [];
    try { all = JSON.parse(localStorage.getItem("sellerProducts")) || []; } catch(e) {}
    if(!all.length){
        try { all = JSON.parse(localStorage.getItem("sokoniProducts")) || []; } catch(e) {}
    }

    const sameCat = all.filter(p => p.id !== product.id && p.category === product.category);
    const others  = all.filter(p => p.id !== product.id && p.category !== product.category);
    const related = [...sameCat, ...others].slice(0, 8);

    if(!related.length){
        if(section) section.style.display = "none";
        return;
    }

    grid.innerHTML = related.map(p => {
        const img   = p.image || "assets/default-product.png";
        const price = Number(p.price).toLocaleString();
        const oos   = p.outOfStock || (p.stock !== undefined && Number(p.stock) === 0);
        const oosOverlay = oos ? `<div style="position:absolute;inset:0;background:rgba(0,0,0,0.52);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900;color:rgba(255,255,255,0.7);letter-spacing:0.5px;text-transform:uppercase;z-index:4;border-radius:12px;">Out of Stock</div>` : "";
        const badge = (() => {
            const ageMs = Date.now() - Number(p.uploadedAt || 0);
            if(ageMs < 86400000*3) return `<div style="position:absolute;top:5px;right:5px;z-index:3;font-size:7px;font-weight:900;padding:2px 5px;border-radius:4px;background:rgba(113,255,0,0.85);color:#041200;text-transform:uppercase;letter-spacing:0.4px;">NEW</div>`;
            if((p.views||0) >= 5)  return `<div style="position:absolute;top:5px;right:5px;z-index:3;font-size:7px;font-weight:900;padding:2px 5px;border-radius:4px;background:rgba(255,80,0,0.88);color:white;text-transform:uppercase;letter-spacing:0.4px;">HOT 🔥</div>`;
            return "";
        })();
        return `
        <div class="yml-card" onclick="openRelatedProduct('${p.id}')">
            ${oosOverlay}
            <div class="yml-img-wrap">
                <img src="${img}" alt="${p.name}" loading="lazy" decoding="async" onerror="this.src='assets/default-product.png'">
                ${badge}
            </div>
            <div class="yml-body">
                <div class="yml-name">${p.name}</div>
                <div class="yml-price">KES ${price}</div>
            </div>
        </div>`;
    }).join("");
}

function openRelatedProduct(id){
    if(!id) return;
    /* Cache the product for an instant render if we have it locally; otherwise
       product.js resolves it from Firestore via the ?id. */
    try {
        let all = JSON.parse(localStorage.getItem("sellerProducts")) || [];
        if(!all.length) all = JSON.parse(localStorage.getItem("sokoniProducts")) || [];
        const p = all.find(x => String(x.id) === String(id));
        if(p) localStorage.setItem("selectedProduct", JSON.stringify(p));
    } catch(e) {}
    /* Navigate with the NEW ?id. product.js resolves the product from the URL id
       (authoritative), so the old approach — set selectedProduct then location.
       reload() WITHOUT changing ?id — just re-rendered the CURRENT product: the
       old ?id won and overwrote selectedProduct, so the tap appeared dead. And a
       related product not cached locally never opened at all. */
    window.location.href = "product.html?id=" + encodeURIComponent(id);
}
window.openRelatedProduct = openRelatedProduct;

/* Viewer/sold counts are populated by sokoni-product-analytics.js with real Firestore data */

/* Run after DOM is ready */
if(product) {
    setTimeout(renderRelatedProducts, 150);
    /* Track + render recently viewed */
    if (typeof _rvTrackProduct === 'function') {
        _rvTrackProduct(product);
    } else {
        setTimeout(function() {
            if (typeof _rvTrackProduct === 'function') _rvTrackProduct(product);
        }, 300);
    }
    setTimeout(function() {
        if (typeof _rvRender === 'function') {
            var pid = new URLSearchParams(location.search).get('id') || product.id || '';
            _rvRender(pid);
        }
    }, 400);
}

/* DECREASE */

function decreaseQty(){
    if (quantity > 1) { quantity--; _syncQtyUI(); }
}

/* ══════════════════════════════════════════════════════════════════════════
   PRODUCT STICKY BUY BAR (Phase C gap #2)
   A persistent mobile purchase surface that slides in once the inline CTA
   scrolls out of view (IntersectionObserver — no scroll polling) and slides
   out when it returns. Dynamic CTA (Buy/Add · Out of Stock · Select Options ·
   Pre-order) + live total that tracks the quantity. Docks above the bottom-nav,
   respects the safe area, mobile-only. Never covers content (fixed, own layer).
══════════════════════════════════════════════════════════════════════════ */
function _prdIsOOS(){
    return (typeof product !== 'undefined' && product &&
        (product.outOfStock === true || (product.stock != null && Number(product.stock) <= 0)));
}
function _prdVariantPending(){
    try {
        if (typeof _variantGroups !== 'function' || typeof product === 'undefined') return false;
        var groups = _variantGroups(product) || [];
        var sel = window._selectedVariants || {};
        for (var i = 0; i < groups.length; i++) {
            var g = groups[i]; if (!g) continue;
            if (g.required === false) continue;
            var key = g.key || g.name || g.label;
            if (key && !sel[key]) return true;
        }
    } catch(_) {}
    return false;
}
function _prdCtaState(){
    if (_prdIsOOS())          return { key:'oos',     label:'Out of Stock' };
    if (_prdVariantPending()) return { key:'variant', label:'Select Options' };
    if (product && product.preorder) return { key:'preorder', label:'&#x26A1; Pre-order' };
    return { key:'normal' };
}
function _updateStickyPrice(){
    var pv = document.getElementById('prdStickyPrice'); if (!pv) return;
    var unit  = Number((typeof product !== 'undefined' && product && product.price) || 0);
    var total = unit * quantity;
    pv.innerHTML = 'KES ' + total.toLocaleString() +
        (quantity > 1 ? ' <span class="pssb-mult">(' + quantity + ' × KES ' + unit.toLocaleString() + ')</span>' : '');
}
function _renderStickyBtns(){
    var wrap = document.getElementById('prdStickyBtns'); if (!wrap) return;
    var st = _prdCtaState();
    if (st.key === 'oos') { wrap.innerHTML = '<div class="pssb-oos">Out of Stock</div>'; return; }
    if (st.key === 'variant') {
        wrap.innerHTML = '<button class="pssb-buy" onclick="document.getElementById(\'prdActions\').scrollIntoView({behavior:\'smooth\',block:\'center\'})">' + st.label + '</button>';
        return;
    }
    var buyLabel = (st.key === 'preorder') ? st.label : '&#x26A1; Buy Now';
    wrap.innerHTML =
        '<button class="pssb-cart" onclick="addToCart()">&#x1F6D2; Add</button>' +
        '<button class="pssb-buy" onclick="buyNowProduct()">' + buyLabel + '</button>';
}
function _initProductStickyBar(){
    if (document.getElementById('prdStickyBar')) return;              /* build once */
    var actions = document.getElementById('prdActions');
    if (!actions || typeof product === 'undefined' || !product) return;

    var css = document.createElement('style'); css.id = 'prdStickyBarCss';
    css.textContent =
      '#prdStickyBar{position:fixed;left:0;right:0;bottom:calc(56px + env(safe-area-inset-bottom,0px));z-index:60;' +
      'display:flex;align-items:center;gap:10px;padding:9px 12px;background:rgba(8,8,8,0.98);' +
      'border-top:1px solid rgba(255,255,255,0.08);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);' +
      'transform:translateY(150%);transition:transform .28s cubic-bezier(.22,1,.36,1);pointer-events:none;will-change:transform;}' +
      '#prdStickyBar.pssb-show{transform:translateY(0);pointer-events:auto;}' +
      '.pssb-info{display:flex;flex-direction:column;line-height:1.15;min-width:0;flex:0 1 auto;max-width:46%;}' +
      '.pssb-name{font-size:11px;color:rgba(255,255,255,0.55);font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '#prdStickyPrice{font-size:16px;font-weight:900;color:#71ff00;white-space:nowrap;letter-spacing:-0.3px;}' +
      '.pssb-mult{font-size:9px;color:rgba(255,255,255,0.4);font-weight:600;}' +
      '.pssb-btns{display:flex;gap:7px;flex:1;justify-content:flex-end;align-items:center;}' +
      '.pssb-cart,.pssb-buy{height:42px;border:none;border-radius:12px;font-weight:900;font-size:12.5px;cursor:pointer;font-family:inherit;white-space:nowrap;padding:0 13px;}' +
      '.pssb-cart{background:rgba(113,255,0,0.12);border:1px solid rgba(113,255,0,0.3);color:#71ff00;}' +
      '.pssb-buy{flex:0 1 150px;background:linear-gradient(135deg,#71ff00,#39e600);color:#050e05;box-shadow:0 2px 10px rgba(113,255,0,0.3);}' +
      '.pssb-oos{flex:1;height:42px;border-radius:12px;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.4);font-weight:900;display:flex;align-items:center;justify-content:center;font-size:13px;}' +
      '@media(min-width:821px){#prdStickyBar{display:none !important;}}';         /* mobile-only */
    document.head.appendChild(css);

    var bar = document.createElement('div');
    bar.id = 'prdStickyBar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Quick purchase');
    bar.innerHTML =
        '<div class="pssb-info"><span class="pssb-name">' + _esc(String(product.name || '').slice(0, 40)) + '</span>' +
        '<span id="prdStickyPrice"></span></div><div class="pssb-btns" id="prdStickyBtns"></div>';
    document.body.appendChild(bar);
    _renderStickyBtns();
    _updateStickyPrice();

    /* Show the bar when the inline actions leave the viewport; hide when they return. */
    try {
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                var show = !e.isIntersecting;
                if (show) { _renderStickyBtns(); _updateStickyPrice(); }   /* reflect current variant/qty/stock */
                bar.classList.toggle('pssb-show', show);
            });
        }, { rootMargin: '0px 0px -12% 0px', threshold: 0 });
        io.observe(actions);
    } catch(_) { /* no IntersectionObserver → leave the bar hidden, inline CTAs still work */ }

    _wireQtyHold();
}

/* ── Press-and-hold quantity acceleration ──────────────────────────────────
   Conservative ramp: 250ms → 120ms → 60ms. Respects stock/min via increase/
   decreaseQty. Stops on release/leave/cancel. Single-tap still works (click).
   Touch + mouse; keyboard already steps via the buttons' click. */
function _wireQtyHold(){
    var box = document.querySelector('.quantity-box'); if (!box) return;
    var btns = box.querySelectorAll('button'); if (btns.length < 2) return;
    [{ el: btns[0], fn: decreaseQty }, { el: btns[1], fn: increaseQty }].forEach(function (b) {
        if (b.el._skHold) return; b.el._skHold = 1;
        var t0 = 0, timer = null;
        function step(){ b.fn(); }
        function schedule(){
            var held = Date.now() - t0;
            var gap = held > 1500 ? 60 : held > 500 ? 120 : 250;
            timer = setTimeout(function(){ step(); schedule(); }, gap);
        }
        function start(ev){
            /* left mouse / touch only; don't hijack the click's own single step */
            if (ev.type === 'mousedown' && ev.button !== 0) return;
            t0 = Date.now();
            clearTimeout(timer);
            schedule();                       /* first repeat after 250ms; the click fires the immediate step */
        }
        function stop(){ clearTimeout(timer); timer = null; }
        b.el.addEventListener('mousedown', start);
        b.el.addEventListener('touchstart', start, { passive: true });
        ['mouseup','mouseleave','touchend','touchcancel','blur'].forEach(function (evt) {
            b.el.addEventListener(evt, stop);
        });
    });
}

/* Boot: init once the async-rendered product actions exist. */
(function _bootProductStickyBar(){
    var tries = 0;
    var iv = setInterval(function () {
        tries++;
        if (document.getElementById('prdActions') && typeof product !== 'undefined' && product) {
            clearInterval(iv); _initProductStickyBar();
        } else if (tries > 40) { clearInterval(iv); }     /* ~10s giveup */
    }, 250);
})();



/* ADD TO CART */

/* Canonical cart (Track 2.3). This read localStorage['cart'] and wrote it back — one of
   thirteen copies of that cycle. SokoniCart is the single access path now.

   The DUPLICATE-ROW quantity model is preserved exactly: `times` pushes N rows rather
   than setting a qty field, because the badges, the checkout line list and the server's
   price cross-check all already agree on what that means. Converting it to a qty field
   here would be a quantity-model change smuggled in as a migration. The one difference is
   that the service copies per row — this pushed the SAME object reference N times, so
   editing one line silently edited them all. */
function _cartSvc(){ return window.SokoniCart || null; }

function _cartItem(){
    return Object.assign({}, product, {
        selectedSize:  window._selectedSize  || null,
        selectedColor: window._selectedColor || null,
        /* Full map alongside the two legacy fields: a shopper can now pick a
           material or a pack size, and neither has a legacy field to land in. */
        selectedVariants: Object.assign({}, window._selectedVariants || {}),
    });
}

/* ── 18+ GATE ───────────────────────────────────────────────────────────────
   The product DETAIL page performed no age check at all and did not even load
   adult-gate.js. Shop blurs restricted cards and Home verifies at action time,
   but both link here — and a direct URL, a shared link or a search result
   reaches this page without passing either. So an 18+ item could be added to
   cart and bought with zero verification: the gate was bypassable simply by
   knowing the product URL.

   That matters beyond UX. category.html states this catalogue complies with
   Kenya's Alcoholic Drinks Control Act and Tobacco Control Act, both of which
   turn on the buyer's age.

   Uses the SAME canonical predicate as Home and Shop, so one product cannot be
   restricted on one surface and open on another. Returns a promise-aware guard;
   callers await it before touching the cart.

   ── FAIL-SAFE, NOT FAIL-OPEN, WHERE IT MATTERS ──────────────────────────────
   If adult-gate.js is missing the guard cannot run the category fallback — that
   list lives inside the module. But the product's OWN flag is readable without
   it, and that is precisely the case where a bypass would be a legal problem
   rather than an inconvenience. So:

     ageRestricted:true  + module unavailable  →  DENY, with an actionable error
     ordinary product    + module unavailable  →  ALLOW

   A missing optional script must not take the unrestricted 96% of the catalogue
   offline; equally it must not become a purchase bypass for an item somebody
   deliberately flagged 18+. The two cases get different answers on purpose. */
function _explicitlyAgeRestricted(p){
    if (!p) return false;
    if (p.ageRestricted === true) return true;
    return typeof p.ageRestriction === "string" && /^\s*18\s*\+?\s*$/.test(p.ageRestriction);
}

async function _ageGuard(){
    try{
        const gateReady = typeof isProductAgeRestricted === "function"
                       && typeof requireAgeVerification === "function";

        if (!gateReady){
            /* Enforcement module unavailable. Deny only what is explicitly flagged. */
            if (_explicitlyAgeRestricted(product)){
                _showProductNotif(
                    "Age verification is unavailable right now — this 18+ item cannot be purchased. Please reload and try again.",
                    "error");
                return false;
            }
            return true;
        }

        if (!isProductAgeRestricted(product)) return true;
        if (typeof isAgeVerified === "function" && isAgeVerified()) return true;
        return !!(await requireAgeVerification());
    }catch(e){
        /* An exception inside the gate is itself an enforcement failure. Same rule:
           protect the flagged item, let ordinary commerce through. */
        if (_explicitlyAgeRestricted(product)){
            try{ _showProductNotif("Age verification failed to load — this 18+ item cannot be purchased right now.", "error"); }catch(_){}
            return false;
        }
        return true;
    }
}

async function addToCart(){

    if(!(await _ageGuard())) return false;

    const c = _cartSvc();
    /* Fails closed. Writing localStorage directly as a fallback is exactly what this
       migration removes, and a button that appears to work while storing nothing is
       worse than one that says it cannot. */
    if(!c){ _showProductNotif("Cart is still loading — try again in a moment", "error"); return false; }

    if(!c.add(_cartItem(), { times: quantity })){
        _showProductNotif("Couldn't add to cart — please try again", "error");
        return false;
    }

    const tag = window._selectedSize ? ` — ${window._selectedSize}` : '';
    _showProductNotif(`${product.name}${tag} added to cart 🛒`, "success");
    return true;

}



/* BUY NOW */

async function buyNowProduct(){

    /* Same 18+ gate as addToCart — Buy Now goes straight to checkout, so it is
       the MORE important of the two to guard, not the lesser. */
    if(!(await _ageGuard())) return false;

    /* Buy Now = express-checkout THIS item only. Build a FRESH cart instead of
       appending to whatever was saved — appending made checkout charge for stale/
       accumulated entries (observed as "the whole stock" instead of 1). */
    const c = _cartSvc();
    if(!c){ _showProductNotif("Cart is still loading — try again in a moment", "error"); return false; }

    const item = _cartItem();
    const rows = [];
    for(let i = 0; i < quantity; i++){ rows.push(item); }

    /* replace() swaps the cart in ONE write. Not clear()+add(): that is two writes, and a
       failure on the second would leave the shopper with an empty cart and nothing added.

       And the navigation now depends on the write. Previously it ran unconditionally, so a
       storage failure sent the shopper to checkout with the PREVIOUS cart still loaded —
       express-checkout for an item they had not chosen, at a total they had not seen. */
    if(!c.replace(rows)){
        _showProductNotif("Couldn't start checkout — please try again", "error");
        return false;
    }

    window.location.href = "checkout.html";
    return true;

}


/* CHANGE PRODUCT IMAGE */

function changeImage(image){
    document.getElementById("mainProductImage").src = image;
}

/* SHARE */

async function contactSellerWhatsApp(){
    let user = null;
    try{ user = JSON.parse(localStorage.getItem("sokoniUser")||"null"); }catch(e){}
    const sellerUid = product.sellerUid || product.sellerId || "";

    /* Logged-in buyer + seller has a UID → create Firestore conversation */
    if(user && user.uid && sellerUid && sellerUid !== user.uid && window.firebaseDB){
        try{
            const FS_URL = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
            const { doc, setDoc, addDoc, collection } = await import(FS_URL);
            const db      = window.firebaseDB;
            const convId  = [user.uid, sellerUid].sort().join("_");
            const firstMsg = `Hi, I'm interested in "${(product.name||"").substring(0,50)}" (KES ${Number(product.price||0).toLocaleString()}). Is it still available?`;
            await setDoc(doc(db,"conversations",convId), {
                participants: [user.uid, sellerUid].sort(),
                names:       { [user.uid]: user.name||user.email||"Buyer", [sellerUid]: product.sellerName||"Seller" },
                productName: (product.name||"").substring(0,60),
                productId:   String(product.id||""),
                lastMessage: firstMsg.substring(0,80),
                lastAt:      Date.now(),
                unread:      { [sellerUid]: 1 },
                createdAt:   Date.now()
            }, { merge: true });
            await addDoc(collection(db,"conversations",convId,"messages"), {
                senderId:   user.uid,
                senderName: user.name||user.email||"Buyer",
                text:       firstMsg,
                guarded:    false,
                ts:         Date.now()
            });
            window.location.href = "messages.html?convo=" + convId;
            return;
        }catch(e){ console.warn("[ContactSeller] Firestore failed:", e.message); }
    }

    /* Fallback: WhatsApp — fire commission gate then open */
    const phone = (product.sellerPhone || product.phone || '').replace(/\D/g,'');
    const waNum = phone.length >= 9 ? (phone.startsWith('254') ? phone : '254' + phone.replace(/^0/,'')) : '254705726803';
    const pname = (product.name || 'this item').substring(0, 60);
    const price = Number(product.price || 0).toLocaleString();
    const plainMsg = `Hi, I'm interested in "${pname}" (KES ${price}) on SOKONI. Is it still available?`;
    if(typeof SokoniPay !== 'undefined' && SokoniPay.waConnect){
        SokoniPay.waConnect(waNum, plainMsg, {
            providerName: product.sellerName || 'Seller',
            category: product.category || 'product',
            serviceDesc: 'Product inquiry: ' + pname,
        });
    } else {
        window.open(`https://wa.me/${waNum}?text=${encodeURIComponent(plainMsg)}`, '_blank');
    }
}
window.contactSellerWhatsApp = contactSellerWhatsApp;

function shareProductWhatsApp(){
    if(window.SokoniShare){
        SokoniShare.open({
            name: product.name,
            price: product.price,
            image: product.image,
            url: 'https://mysokoni.co.ke/product.html?id=' + (product.id || ''),
            description: product.description || product.name
        });
        return;
    }
    const text = encodeURIComponent(`🛍️ Check out "${product.name}" on SOKONI — KES ${Number(product.price).toLocaleString()}\n\nhttps://mysokoni.co.ke/product.html`);
    window.open(`https://wa.me/?text=${text}`, "_blank");
}

/* MAKE AN OFFER */

function openMakeOffer(){
    const panel = document.getElementById("offerPanel");
    if(panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
}

function submitOffer(){
    const priceEl = document.getElementById("offerPrice");
    const msgEl   = document.getElementById("offerMsg");
    const confirmEl = document.getElementById("offerConfirm");
    const offerPrice = Number(priceEl?.value || 0);
    if(!offerPrice || offerPrice <= 0){
        if(confirmEl){ confirmEl.textContent = "Please enter a valid offer price."; confirmEl.style.color = "#ff6b6b"; }
        return;
    }
    const user = JSON.parse(localStorage.getItem("sokoniUser")||"null");
    const offer = {
        id:          "OFF"+Date.now(),
        productId:   product.id,
        productName: product.name,
        listedPrice: product.price,
        offerPrice,
        message:     msgEl?.value.trim() || "",
        buyerName:   user?.name || "Anonymous",
        buyerEmail:  user?.email || "",
        sellerName:  product.sellerName || "Sokoni Seller",
        date:        new Date().toLocaleDateString("en-KE",{day:"numeric",month:"short",year:"numeric"}),
        timestamp:   Date.now(),
        status:      "pending"
    };
    let offers = [];
    try { offers = JSON.parse(localStorage.getItem("sokoniOffers"))||[]; } catch(e){}
    offers.unshift(offer);
    localStorage.setItem("sokoniOffers", JSON.stringify(offers));
    if(confirmEl){
        confirmEl.innerHTML = `✅ Offer of <strong>KES ${offerPrice.toLocaleString()}</strong> sent! The seller will respond via Messages.`;
        confirmEl.style.color = "#71ff00";
    }
    if(priceEl) priceEl.value = "";
    if(msgEl)   msgEl.value   = "";
}

/* WISHLIST (product page) */

/* Canonical: wishlistItems/{uid}_{productId} via SokoniWishlist → commerceDispatch.
   This wrote localStorage['wishlist'] directly, which made saved items per-DEVICE
   rather than per-USER: a clean sign-out cleared them, but a force-quit or a session
   restored as a different account left one shopper looking at another's saves. The
   service derives the owner from Firebase Auth and the deterministic document id
   makes a repeat save idempotent, so the "Already in your Wishlist" branch is now a
   real state check rather than a scan of a local array. */
function addToWishlistProduct(){
    const W = window.SokoniWishlist;
    if (!W) { _showProductNotif("Wishlist is still loading — try again.", "error"); return; }
    if (W.isWishlisted(product.id)) { _showProductNotif("Already in your Wishlist!", "error"); return; }

    W.add({
        productId: product.id,
        shopId:    product.shopId || product.sellerId || null,
        name:      product.name,
        price:     product.price,
        image:     product.image,
    }).then(function(){
        _showProductNotif("❤️ Added to Wishlist!", "success");
        _syncWishlistBtn();
    }).catch(function(e){
        /* No success message before the canonical write lands. */
        _showProductNotif(
            /sign in/i.test(e && e.message || '') ? "Sign in to save items" : "Couldn't save — try again",
            "error");
    });
}

/* Reflect canonical state on the button so the same product reads the same way here
   as it does on every other surface. */
function _syncWishlistBtn(){
    try {
        const btn = document.querySelector('.prd-cta-icon-btn.wishlist');
        if (!btn || !window.SokoniWishlist || !product) return;
        const on = window.SokoniWishlist.isWishlisted(product.id);
        btn.innerHTML = on ? '❤️ Saved' : '❤️ Save';
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    } catch(e){}
}
window.addEventListener('sokoni:wishlist-changed', _syncWishlistBtn);

window.shareProductWhatsApp  = shareProductWhatsApp;
window.openMakeOffer         = openMakeOffer;
window.submitOffer           = submitOffer;
window.addToWishlistProduct  = addToWishlistProduct;

/* ==============================================
   Q&A SYSTEM
============================================== */

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function renderQa(){
    if(!product) return;
    let allQa = {};
    try { allQa = JSON.parse(localStorage.getItem("sokoniQA"))||{}; } catch(e){}
    const qs = (allQa[product.id] || []).slice(0, 20);

    const listEl = document.getElementById("qaList");
    const countEl = document.getElementById("qaCount");
    if(!listEl) return;

    if(countEl) countEl.textContent = qs.length + " question" + (qs.length!==1?"s":"");

    if(!qs.length){
        listEl.innerHTML = `<div style="color:rgba(255,255,255,0.25);font-size:13px;margin-bottom:8px;">No questions yet — be the first to ask!</div>`;
        return;
    }

    listEl.innerHTML = qs.map(q=>`
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:14px 16px;margin-bottom:10px;">
            <div style="font-size:13px;font-weight:700;color:white;margin-bottom:6px;">❓ ${_esc(q.question)}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.3);margin-bottom:${q.answer?'10px':'0'};">— ${_esc(q.asker||"Anonymous")} · ${_esc(q.date||"")}</div>
            ${q.answer ? `
                <div style="background:rgba(113,255,0,0.06);border:1px solid rgba(113,255,0,0.15);border-radius:10px;padding:10px 14px;">
                    <div style="font-size:11px;font-weight:700;color:#71ff00;margin-bottom:4px;">💬 Seller Reply · ${_esc(q.answeredAt||"")}</div>
                    <div style="font-size:13px;color:rgba(255,255,255,0.8);">${_esc(q.answer)}</div>
                </div>
            ` : `<div style="font-size:11px;color:rgba(255,152,0,0.7);">⏳ Awaiting seller reply…</div>`}
        </div>
    `).join("");
}

function submitQuestion(){
    const qInput = document.getElementById("qaInput");
    const nInput = document.getElementById("qaNameInput");
    if(!qInput) return;
    const question = qInput.value.trim();
    if(!question){ return; }

    let allQa = {};
    try { allQa = JSON.parse(localStorage.getItem("sokoniQA"))||{}; } catch(e){}
    if(!allQa[product.id]) allQa[product.id] = [];

    allQa[product.id].unshift({
        id: "q" + Date.now(),
        question,
        asker: (nInput && nInput.value.trim()) || "Anonymous",
        date: new Date().toLocaleDateString("en-KE",{day:"numeric",month:"short",year:"numeric"}),
        answer: null,
        answeredAt: null
    });
    localStorage.setItem("sokoniQA", JSON.stringify(allQa));

    qInput.value = "";
    if(nInput) nInput.value = "";
    renderQa();
}

window.submitQuestion = submitQuestion;
renderQa();

/* ==============================================
   LIVE PUBLIC COMMENTS
============================================== */

function renderComments(){
  if(!product) return;
  let all = {};
  try { all = JSON.parse(localStorage.getItem("sokoniComments"))||{}; } catch(e){}
  const comments = (all[product.id] || []).slice(0, 60);
  const listEl  = document.getElementById("liveCommentsList");
  const countEl = document.getElementById("commentCount");
  if(!listEl) return;
  if(countEl) countEl.textContent = comments.length + " comment" + (comments.length!==1?"s":"");
  if(!comments.length){
    listEl.innerHTML = `<div style="color:rgba(255,255,255,0.25);font-size:13px;margin-bottom:8px;">No comments yet — be the first!</div>`;
    return;
  }
  listEl.innerHTML = comments.map(c=>`
    <div style="display:flex;gap:10px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
      <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#71ff00,#4fc800);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:900;color:black;flex-shrink:0;">${_esc((c.author||"?")[0].toUpperCase())}</div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;">
          <span style="font-size:13px;font-weight:700;color:white;">${_esc(c.author||"Anonymous")}</span>
          <span style="font-size:10px;color:rgba(255,255,255,0.3);">${_esc(c.date||"")}</span>
        </div>
        <div style="font-size:13px;color:rgba(255,255,255,0.8);line-height:1.55;word-break:break-word;">${_esc(c.text)}</div>
        <button onclick="likeComment('${_esc(c.id)}')" id="like-${_esc(c.id)}" style="margin-top:6px;background:none;border:none;color:rgba(255,255,255,0.35);font-size:11px;cursor:pointer;padding:0;font-family:inherit;transition:color 0.2s;">👍 ${c.likes||0}</button>
      </div>
    </div>
  `).join("");
}

function postComment(){
  const nameEl = document.getElementById("commentName");
  const textEl = document.getElementById("commentText");
  if(!textEl) return;
  const text = textEl.value.trim();
  if(!text){ textEl.style.borderColor="rgba(255,77,77,0.5)"; return; }
  textEl.style.borderColor="rgba(255,255,255,0.1)";

  let all = {};
  try { all = JSON.parse(localStorage.getItem("sokoniComments"))||{}; } catch(e){}
  if(!all[product.id]) all[product.id] = [];
  all[product.id].unshift({
    id:      "c"+Date.now(),
    text,
    author:  (nameEl&&nameEl.value.trim())||"Anonymous",
    date:    new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}) + " · " +
             new Date().toLocaleDateString("en-KE",{day:"numeric",month:"short"}),
    likes:   0,
    timestamp: Date.now()
  });
  localStorage.setItem("sokoniComments", JSON.stringify(all));
  textEl.value="";
  if(nameEl) nameEl.value="";
  renderComments();
}

function likeComment(id){
  let all = {};
  try { all = JSON.parse(localStorage.getItem("sokoniComments"))||{}; } catch(e){}
  const list = all[product.id]||[];
  const c = list.find(x=>x.id===id);
  if(c){
    c.likes=(c.likes||0)+1;
    localStorage.setItem("sokoniComments",JSON.stringify(all));
    const btn=document.getElementById("like-"+id);
    if(btn) btn.textContent="👍 "+c.likes;
  }
}

window.postComment  = postComment;
window.likeComment  = likeComment;
renderComments();

/* ==============================================
   VIDEO DOWNLOAD (original + compressed)
============================================== */

function downloadProductVideo(compress){
  const video    = document.getElementById("productVideoEl");
  const statusEl = document.getElementById("videoDownloadStatus");
  const cBtn     = document.getElementById("compressBtn");
  if(!video) return;

  if(!compress){
    const a = document.createElement("a");
    a.href = video.src;
    a.download = "sokoni-product-video.mp4";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if(statusEl) statusEl.innerHTML = `<span style="color:#71ff00;"><i class="fas fa-check"></i> Download started!</span>`;
    return;
  }

  if(!window.MediaRecorder || !MediaRecorder.isTypeSupported("video/webm")){
    if(statusEl) statusEl.innerHTML = `<span style="color:#ff9800;">Compression unavailable in this browser — downloading original instead</span>`;
    downloadProductVideo(false);
    return;
  }

  if(cBtn){ cBtn.disabled=true; cBtn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Compressing…'; }
  if(statusEl) statusEl.innerHTML=`<i class="fas fa-spinner fa-spin"></i> Compressing video, please wait…`;

  const canvas=document.createElement("canvas");
  const aspect=(video.videoHeight&&video.videoWidth)?(video.videoHeight/video.videoWidth):(9/16);
  canvas.width=640; canvas.height=Math.round(640*aspect);
  const ctx=canvas.getContext("2d");

  const mimeType=MediaRecorder.isTypeSupported("video/webm;codecs=vp8")?"video/webm;codecs=vp8":"video/webm";
  const stream=canvas.captureStream(24);
  const recorder=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:900000});
  const chunks=[];

  recorder.ondataavailable=e=>{if(e.data&&e.data.size>0)chunks.push(e.data);};
  recorder.onstop=()=>{
    const blob=new Blob(chunks,{type:"video/webm"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download="sokoni-product-compressed.webm";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const kb=Math.round(blob.size/1024);
    if(statusEl) statusEl.innerHTML=`<span style="color:#71ff00;"><i class="fas fa-check"></i> Compressed! (${kb<1024?kb+"KB":Math.round(kb/1024)+"MB"}) — check your downloads</span>`;
    if(cBtn){ cBtn.disabled=false; cBtn.innerHTML='<i class="fas fa-compress-alt"></i> Compress &amp; Download'; }
  };

  video.currentTime=0;
  video.muted=true;

  const draw=()=>{
    if(!video.ended&&!video.paused){
      ctx.drawImage(video,0,0,canvas.width,canvas.height);
      requestAnimationFrame(draw);
    } else {
      if(recorder.state==="recording") recorder.stop();
    }
  };

  video.onplay=draw;
  video.onended=()=>{ if(recorder.state==="recording") recorder.stop(); };
  video.play().catch(()=>{
    if(statusEl) statusEl.innerHTML=`<span style="color:#ff9800;">Could not auto-play for compression — downloading original</span>`;
    if(cBtn){ cBtn.disabled=false; cBtn.innerHTML='<i class="fas fa-compress-alt"></i> Compress &amp; Download'; }
    downloadProductVideo(false);
  });
  recorder.start(200);
}

window.downloadProductVideo=downloadProductVideo;

/* ═══════════════════════════════════════════════════════
   GALLERY v2 — swipe, navigation, lightbox
═══════════════════════════════════════════════════════ */
(function() {
    var _media = [];
    var _idx   = 0;

    function _collectMedia() {
        _media = [];
        document.querySelectorAll('.prd-thumb').forEach(function(t) {
            var img = t.querySelector('img');
            var vid = t.querySelector('video');
            if (vid) _media.push({ type:'video', src: vid.src });
            else if (img) _media.push({ type:'image', src: img.src });
        });
    }

    function _setActive(n) {
        if (!_media.length) _collectMedia();
        _idx = ((n % _media.length) + _media.length) % _media.length;
        var m = _media[_idx];
        var main = document.getElementById('prdGalleryMain');
        if (!main) return;
        /* Swap main media */
        if (m.type === 'video') {
            main.querySelector('img') && (main.querySelector('img').remove());
            var existVid = main.querySelector('video#prdMainVid');
            if (!existVid) {
                var v = document.createElement('video');
                v.id = 'prdMainVid'; v.src = m.src; v.controls = true; v.muted = true; v.playsInline = true;
                v.style.cssText = 'width:100%;height:100%;object-fit:contain;';
                main.insertBefore(v, main.firstChild);
            } else { existVid.src = m.src; }
        } else {
            main.querySelector('video#prdMainVid') && (main.querySelector('video#prdMainVid').remove());
            var existImg = document.getElementById('prdMainImg');
            if (!existImg) {
                var img = document.createElement('img');
                img.id = 'prdMainImg'; img.alt = '';
                main.insertBefore(img, main.firstChild);
                existImg = img;
            }
            existImg.src = m.src;
        }
        /* Update thumbs */
        document.querySelectorAll('.prd-thumb').forEach(function(t, i) { t.classList.toggle('active', i === _idx); });
        /* Update dots */
        document.querySelectorAll('.prd-gallery-dot').forEach(function(d, i) { d.classList.toggle('active', i === _idx); });
    }

    window._prdGalleryGo   = _setActive;
    window._prdGalleryNext = function() { _setActive(_idx + 1); };
    window._prdGalleryPrev = function() { _setActive(_idx - 1); };

    /* Touch/swipe on gallery wrap */
    document.addEventListener('DOMContentLoaded', function() {
        var wrap = document.getElementById('prdGalleryWrap');
        if (!wrap) return;
        _collectMedia();
        var sx = 0;
        wrap.addEventListener('touchstart', function(e) { sx = e.changedTouches[0].screenX; }, { passive:true });
        wrap.addEventListener('touchend', function(e) {
            var dx = e.changedTouches[0].screenX - sx;
            if (Math.abs(dx) > 40) dx < 0 ? window._prdGalleryNext() : window._prdGalleryPrev();
        }, { passive:true });
    });

    /* Lightbox */
    function _ensureLightbox() {
        if (document.getElementById('prd-lightbox')) return;
        var lb = document.createElement('div');
        lb.id = 'prd-lightbox';
        lb.setAttribute('role', 'dialog');
        lb.setAttribute('aria-modal', 'true');
        lb.setAttribute('aria-label', 'Product image fullscreen');
        lb.innerHTML =
            '<button id="prd-lightbox-close" aria-label="Close">&times;</button>' +
            '<img id="prd-lightbox-img" alt="Product image" style="display:none;">' +
            '<video id="prd-lightbox-vid" controls muted playsinline style="display:none;"></video>' +
            '<div id="prd-lightbox-counter"></div>';
        document.body.appendChild(lb);
        lb.querySelector('#prd-lightbox-close').onclick = function() { lb.classList.remove('open'); };
        lb.addEventListener('click', function(e) { if (e.target === lb) lb.classList.remove('open'); });
        document.addEventListener('keydown', function(e) { if (e.key === 'Escape') lb.classList.remove('open'); });
    }

    window._prdLightboxOpen = function() {
        if (!_media.length) _collectMedia();
        if (!_media.length) return;
        _ensureLightbox();
        var m = _media[_idx];
        var lb   = document.getElementById('prd-lightbox');
        var lbImg = document.getElementById('prd-lightbox-img');
        var lbVid = document.getElementById('prd-lightbox-vid');
        var lbCnt = document.getElementById('prd-lightbox-counter');
        if (m.type === 'video') {
            lbImg.style.display = 'none'; lbVid.style.display = '';
            lbVid.src = m.src; lbVid.play().catch(function(){});
        } else {
            lbVid.style.display = 'none'; lbImg.style.display = '';
            lbImg.src = m.src;
        }
        if (lbCnt) lbCnt.textContent = (_idx + 1) + ' / ' + _media.length;
        lb.classList.add('open');
    };
})();

/* ═══════════════════════════════════════════════════════
   RECENTLY VIEWED — localStorage tracking + render
═══════════════════════════════════════════════════════ */
(function() {
    var RV_KEY = 'sokoni_recently_viewed';
    var MAX    = 12;

    function _getList() {
        try { return JSON.parse(localStorage.getItem(RV_KEY) || '[]'); } catch(_) { return []; }
    }

    function _saveList(list) {
        try { localStorage.setItem(RV_KEY, JSON.stringify(list.slice(0, MAX))); } catch(_) {}
    }

    window._rvTrackProduct = function(p) {
        if (!p || !p.id) return;
        var list = _getList().filter(function(x) { return x.id !== p.id; });
        list.unshift({ id: p.id, name: p.name || '', price: p.price || 0, image: (window.pickProductImage ? pickProductImage(p) : (p.image || '')) });
        _saveList(list);
    };

    window._rvRender = function(currentId) {
        var list = _getList().filter(function(x) { return x.id !== currentId; }).slice(0, 8);
        if (!list.length) return;
        var section = document.getElementById('prdRvSection');
        var strip   = document.getElementById('prdRvStrip');
        if (!section || !strip) return;
        strip.innerHTML = list.map(function(item) {
            return '<a href="product.html?id=' + encodeURIComponent(item.id) + '" class="prd-rv-card">' +
                '<div class="prd-rv-img"><img src="' + (item.image || 'assets/default-product.png') + '" alt="" loading="lazy" onerror="this.src=\'assets/default-product.png\'"></div>' +
                '<div class="prd-rv-name">' + (item.name || '').substring(0, 30).replace(/</g, '&lt;') + '</div>' +
                '<div class="prd-rv-price">KES ' + Number(item.price || 0).toLocaleString() + '</div>' +
            '</a>';
        }).join('');
        section.style.display = '';
    };
})();

/* ═══════════════════════════════════════════════════════
   PHONE MASKING
═══════════════════════════════════════════════════════ */
function _maskPhone(phone) {
    if (!phone) return '';
    var p = String(phone).replace(/\s+/g, '');
    if (p.length < 7) return p;
    return p.slice(0, 4) + '***' + p.slice(-3);
}

/* ═══════════════════════════════════════════════════════
   P13: WhatsApp gating — premium gets direct link,
         non-premium gets in-app contact request modal
═══════════════════════════════════════════════════════ */
function contactSellerGated() {
    var isPremium = window._prdSellerIsPremium;
    var waNumber  = window._prdSellerWhatsApp || window._prdSellerPhone || '';
    if (isPremium && waNumber) {
        /* Premium seller — direct WhatsApp */
        var productTitle = (typeof product !== 'undefined' && product.name) ? product.name : 'this product';
        var msg = 'Hi, I am interested in *' + productTitle + '* listed on SOKONI. ' + window.location.href;
        var clean = waNumber.replace(/[^0-9]/g,'');
        if (clean.startsWith('0')) clean = '254' + clean.slice(1);
        window.open('https://wa.me/' + clean + '?text=' + encodeURIComponent(msg), '_blank');
    } else {
        /* Non-premium — open in-app contact request */
        _openContactRequestModal();
    }
}
window.contactSellerGated = contactSellerGated;

/* Keep legacy name for any remaining references */
window.contactSellerWhatsApp = contactSellerGated;

/* ═══════════════════════════════════════════════════════
   P15: Contact Request Modal + Firestore lead record
═══════════════════════════════════════════════════════ */
function _ensureContactModal() {
    if (document.getElementById('prd-contact-modal')) return;
    var modal = document.createElement('div');
    modal.id = 'prd-contact-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Contact seller');
    modal.innerHTML =
        '<div class="prd-contact-box">' +
            '<h3>Contact Seller</h3>' +
            '<p>Send a contact request. The seller will reach out to you directly.</p>' +
            '<input class="prd-contact-inp" id="prdCrName"  type="text"  placeholder="Your name *" style="font-size:16px;">' +
            '<input class="prd-contact-inp" id="prdCrPhone" type="tel"   placeholder="Your phone number *" style="font-size:16px;">' +
            '<textarea class="prd-contact-inp" id="prdCrMsg" rows="2" placeholder="Message (optional)" style="resize:none;"></textarea>' +
            '<button class="prd-contact-btn" id="prdCrSubmit" onclick="_submitContactRequest()">Send Request</button>' +
            '<div id="prdCrFeedback" style="margin-top:10px;font-size:13px;"></div>' +
            '<button onclick="document.getElementById(\'prd-contact-modal\').classList.remove(\'open\')" ' +
              'style="display:block;width:100%;margin-top:10px;padding:10px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.5);border-radius:10px;cursor:pointer;font-family:inherit;font-size:13px;">Cancel</button>' +
        '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.classList.remove('open'); });
}

function _openContactRequestModal() {
    _ensureContactModal();
    document.getElementById('prd-contact-modal').classList.add('open');
    setTimeout(function() { var el = document.getElementById('prdCrName'); if (el) el.focus(); }, 150);
}

async function _submitContactRequest() {
    var name  = (document.getElementById('prdCrName')  || {}).value || '';
    var phone = (document.getElementById('prdCrPhone') || {}).value || '';
    var msg   = (document.getElementById('prdCrMsg')   || {}).value || '';
    var fb    = document.getElementById('prdCrFeedback');
    var btn   = document.getElementById('prdCrSubmit');
    if (!name.trim() || !phone.trim()) {
        if (fb) { fb.textContent = 'Please enter your name and phone number.'; fb.style.color = '#ff9800'; }
        return;
    }
    /* Basic phone sanitization — no internal storage of full number outside lead record */
    var cleanPhone = phone.replace(/[^0-9+]/g, '');
    if (cleanPhone.length < 9) {
        if (fb) { fb.textContent = 'Please enter a valid phone number.'; fb.style.color = '#ff9800'; }
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
        var {initializeApp,getApps} = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
        var {getFirestore,collection,addDoc,serverTimestamp} = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        var cfg = {apiKey:"AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE",authDomain: "auth.mysokoni.co.ke",
          projectId:"sokoni-aeb26",storageBucket:"sokoni-aeb26.firebasestorage.app",
          messagingSenderId:"24799054989",appId:"1:24799054989:web:e1cf6ca8c281bf1abf26c4"};
        var app  = getApps().length ? getApps()[0] : initializeApp(cfg);
        var db   = getFirestore(app);
        var pid  = new URLSearchParams(location.search).get('id') || (typeof product !== 'undefined' ? (product.id || '') : '');
        var lead = {
            buyerName:    name.trim(),
            buyerPhone:   cleanPhone,
            message:      msg.trim(),
            productId:    pid,
            productName:  (typeof product !== 'undefined' && product.name) ? product.name : '',
            sellerUid:    (typeof product !== 'undefined') ? (product.sellerUid || product.sellerId || '') : '',
            sellerName:   (typeof product !== 'undefined') ? (product.sellerName || '') : '',
            status:       'pending',
            createdAt:    serverTimestamp(),
            source:       'product_page',
        };
        await addDoc(collection(db, 'contactRequests'), lead);
        if (fb) { fb.textContent = '✅ Request sent! The seller will contact you soon.'; fb.style.color = '#71ff00'; }
        if (btn) { btn.textContent = 'Sent!'; }
        setTimeout(function() { document.getElementById('prd-contact-modal').classList.remove('open'); }, 2000);
    } catch(e) {
        if (fb) { fb.textContent = 'Could not send request. Please try again.'; fb.style.color = '#ff4d4d'; }
        if (btn) { btn.disabled = false; btn.textContent = 'Send Request'; }
    }
}
window._submitContactRequest = _submitContactRequest;

/* ═══════════════════════════════════════════════════════
   Q&A — ask question modal
═══════════════════════════════════════════════════════ */
function openAskQuestion() {
    var q = prompt('Ask the seller a question about this product:');
    if (!q || !q.trim()) return;
    (async function() {
        try {
            var {initializeApp,getApps} = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
            var {getFirestore,collection,addDoc,serverTimestamp} = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
            var cfg = {apiKey:"AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE",authDomain: "auth.mysokoni.co.ke",
              projectId:"sokoni-aeb26",storageBucket:"sokoni-aeb26.firebasestorage.app",
              messagingSenderId:"24799054989",appId:"1:24799054989:web:e1cf6ca8c281bf1abf26c4"};
            var app = getApps().length ? getApps()[0] : initializeApp(cfg);
            var db  = getFirestore(app);
            var pid = new URLSearchParams(location.search).get('id') || (typeof product !== 'undefined' ? (product.id || '') : '');
            await addDoc(collection(db, 'productQA'), {
                productId:  pid,
                sellerUid:  (typeof product !== 'undefined') ? (product.sellerUid || '') : '',
                question:   q.trim(),
                answer:     '',
                createdAt:  serverTimestamp(),
            });
            var list = document.getElementById('prdQaList');
            if (list) {
                var item = document.createElement('div');
                item.className = 'prd-qa-item';
                var qDiv = document.createElement('div');
                qDiv.className = 'prd-qa-q';
                qDiv.textContent = 'Q: ' + q.trim();
                var aDiv = document.createElement('div');
                aDiv.className = 'prd-qa-a';
                aDiv.style.cssText = 'color:rgba(255,255,255,0.3);font-style:italic;';
                aDiv.textContent = 'Awaiting seller reply…';
                item.appendChild(qDiv);
                item.appendChild(aDiv);
                list.insertBefore(item, list.firstChild);
            }
        } catch(_) { alert('Could not send your question. Please try again.'); }
    })();
}
window.openAskQuestion = openAskQuestion;