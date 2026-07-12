/* ================================================================
   SOKONI SPOTLIGHT ENGINE  v1.0
   Auto-rotates featured products, sellers & stories on the home page.
   Boosted/paid items are weighted to appear more frequently.
   Called by index.html after products load.
================================================================ */
window.SokoniSpotlight = (function(){

  /* ── STATIC SELLER POOL (merged with Firestore featured sellers) ── */
  var SELLER_POOL = [
    { id:'kaspa',        name:'Kaspa Prints',       loc:'Nairobi',  stars:'⭐⭐⭐⭐⭐', rating:'4.9 · 320 Sales',  tags:['🖨️ Printing','🎨 Branding'],      cat:'printing',    img:'assets/Sokoni Logo.png', boosted:true  },
    { id:'kenshop',      name:'KenShop',             loc:'Mombasa',  stars:'⭐⭐⭐⭐⭐', rating:'4.8 · 210 Sales',  tags:['👗 Fashion','👟 Shoes'],           cat:'fashion',     img:'assets/Sokoni Logo.png', boosted:true  },
    { id:'sokoni_elec',  name:'Sokoni Electronics',  loc:'Nairobi',  stars:'⭐⭐⭐⭐⭐', rating:'4.7 · 185 Sales',  tags:['📱 Phones','💻 Laptops'],          cat:'electronics', img:'assets/Sokoni Logo.png', boosted:false },
    { id:'freshfarm',    name:'FreshFarm Kenya',     loc:'Nairobi',  stars:'⭐⭐⭐⭐⭐', rating:'4.8 · 420 Sales',  tags:['🥦 Produce','🍗 Meat'],            cat:'grocery',     img:'assets/Sokoni Logo.png', boosted:true  },
    { id:'beautyke',     name:'BeautyKE',            loc:'Kisumu',   stars:'⭐⭐⭐⭐⭐', rating:'4.9 · 290 Sales',  tags:['💄 Makeup','💅 Skincare'],         cat:'beauty',      img:'assets/Sokoni Logo.png', boosted:false },
    { id:'homesdecor',   name:'Homes & Decor KE',    loc:'Nairobi',  stars:'⭐⭐⭐⭐⭐', rating:'4.7 · 145 Sales',  tags:['🛋️ Furniture','🏠 Decor'],        cat:'home-decor',  img:'assets/Sokoni Logo.png', boosted:false },
    { id:'autoparts',    name:'AutoParts Kenya',     loc:'Nairobi',  stars:'⭐⭐⭐⭐⭐', rating:'4.8 · 310 Sales',  tags:['🔧 Car Parts','🚗 Accessories'],   cat:'auto',        img:'assets/Sokoni Logo.png', boosted:true  },
    { id:'sportzone',    name:'SportZone KE',        loc:'Mombasa',  stars:'⭐⭐⭐⭐',  rating:'4.6 · 180 Sales',  tags:['⚽ Sports','🏋️ Fitness'],          cat:'sports',      img:'assets/Sokoni Logo.png', boosted:false },
    { id:'techke',       name:'TechKE Store',        loc:'Nairobi',  stars:'⭐⭐⭐⭐⭐', rating:'4.8 · 250 Sales',  tags:['💻 Laptops','🔌 Accessories'],     cat:'electronics', img:'assets/Sokoni Logo.png', boosted:false },
    { id:'babyworld',    name:'BabyWorld Kenya',     loc:'Nairobi',  stars:'⭐⭐⭐⭐⭐', rating:'4.9 · 190 Sales',  tags:['🍼 Baby Gear','🧸 Toys'],          cat:'baby',        img:'assets/Sokoni Logo.png', boosted:true  },
    { id:'bookshop',     name:'Sokoni Bookshop',     loc:'Nairobi',  stars:'⭐⭐⭐⭐',  rating:'4.5 · 95 Sales',   tags:['📚 Books','🎓 Education'],         cat:'books',       img:'assets/Sokoni Logo.png', boosted:false },
    { id:'petshop',      name:'PetCare Kenya',       loc:'Nairobi',  stars:'⭐⭐⭐⭐⭐', rating:'4.7 · 130 Sales',  tags:['🐾 Pet Food','🏠 Pet Supplies'],   cat:'pets',        img:'assets/Sokoni Logo.png', boosted:false },
  ];

  var _productPool  = [];
  var _productPage  = 0;
  var _sellerPage   = 0;
  var _storyActive  = 0;
  var _sellerTimer  = null;
  var _productTimer = null;
  var _storyTimer   = null;
  var _paused       = false;

  /* ── Weighted pool: boosted items appear 3x ── */
  function _weighted(pool) {
    var out = [];
    pool.forEach(function(s){ out.push(s); if(s.boosted){ out.push(s); out.push(s); } });
    return out.sort(function(){ return Math.random()-0.5; });
  }

  /* ── Fade a container out, swap content, fade in ── */
  function _fade(el, cb) {
    el.style.transition = 'opacity 0.35s ease';
    el.style.opacity = '0';
    setTimeout(function(){
      try{ cb(); }catch(e){}
      el.style.opacity = '1';
    }, 350);
  }

  /* ── Build one seller card HTML ── */
  function _sellerCard(s) {
    var badge = s.boosted
      ? '<div class="seller-badge verified-badge" style="background:linear-gradient(135deg,rgba(113,255,0,0.18),rgba(0,212,255,0.1));border-color:rgba(113,255,0,0.4);color:#71ff00;">✓ SOKONI VERIFIED ⚡</div>'
      : '<div class="seller-badge verified-badge">✓ SOKONI VERIFIED</div>';
    return '<div class="seller-card seller-card-verified">'
      + badge
      + '<div class="seller-avatar"><img loading="lazy" src="' + s.img + '" alt="' + s.name + '" onerror="this.src=\'assets/Sokoni Logo.png\'"></div>'
      + '<h3>' + s.name + '</h3>'
      + '<div class="seller-location-tag">📍 ' + s.loc + '</div>'
      + '<div class="seller-stars">' + s.stars + '</div>'
      + '<p class="seller-rating-text">' + s.rating + '</p>'
      + '<div class="seller-tags">' + s.tags.map(function(t){ return '<span class="seller-tag">'+t+'</span>'; }).join('') + '</div>'
      + '<a href="category.html?cat=' + s.cat + '" class="seller-visit-btn">🏪 Visit Store</a>'
      + '<div class="seller-follow-row">'
      + '<button type="button" class="seller-follow-btn" onclick="window.SokoniSocial&&window.SokoniSocial.toggleFollow(\''+s.id+'\',\''+s.name+'\',this,\'store\')">+ Follow</button>'
      + '<button type="button" class="seller-share-btn" onclick="window.SokoniSocial&&window.SokoniSocial.openShareModal({id:\''+s.id+'\',name:\''+s.name+'\',type:\'store\'})">📣</button>'
      + '</div></div>';
  }

  /* ── Render next 3 sellers ── */
  function _renderSellers() {
    var grid = document.getElementById('_spSellersGrid');
    if(!grid || _paused) return;
    var pool = _weighted(SELLER_POOL);
    _sellerPage = (_sellerPage + 3) % pool.length;
    var chunk = pool.slice(_sellerPage, _sellerPage + 3);
    if(chunk.length < 3) chunk = chunk.concat(pool.slice(0, 3 - chunk.length));
    var become = '<div class="seller-card become-seller">'
      + '<div class="become-icon">🏪</div>'
      + '<h3>Become a Seller</h3>'
      + '<p class="seller-rating-text">Join 500+ sellers earning on Sokoni</p>'
      + '<div class="become-perks"><span>✅ Free listings</span><span>💸 Fast payouts</span><span>📊 Analytics</span></div>'
      + '<a href="seller.html" class="seller-visit-btn green-btn"><i class="fas fa-rocket"></i> Start Selling</a></div>';
    _fade(grid, function(){
      grid.innerHTML = chunk.map(_sellerCard).join('') + become;
    });
  }

  /* ── Rotate products: next page of 8 ── */
  function _rotateProducts() {
    if(!_productPool.length || _paused) return;
    var container = document.getElementById('productsContainer');
    if(!container) return;
    var pageSize = 8;
    var totalPages = Math.ceil(_productPool.length / pageSize);
    if(totalPages < 2) return;
    _productPage = (_productPage + 1) % totalPages;
    var chunk = _productPool.slice(_productPage * pageSize, _productPage * pageSize + pageSize);
    if(!chunk.length){ _productPage = 0; chunk = _productPool.slice(0, pageSize); }
    _fade(container, function(){
      if(typeof displayProducts === 'function') displayProducts(chunk);
    });
    _updateLiveCount(_productPage, totalPages);
  }

  /* ── Glow-cycle featured story rings ── */
  function _rotateStories() {
    if(_paused) return;
    var rings = document.querySelectorAll('#storiesRing [data-story-id]');
    if(rings.length < 2) return;
    rings.forEach(function(r){ r.querySelector('div')&&r.querySelector('div').classList.remove('_sp-glow'); });
    _storyActive = (_storyActive + 1) % rings.length;
    var active = rings[_storyActive].querySelector('div');
    if(active) active.classList.add('_sp-glow');
  }

  /* ── Update live counter badge ── */
  function _updateLiveCount(page, total) {
    var el = document.getElementById('_spPageBadge');
    if(el) el.textContent = (page + 1) + '/' + total;
  }

  /* ── Load Firestore featured sellers & merge ── */
  function _loadFirestoreSellers() {
    Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js')
    ]).then(function(mods){
      var initApp = mods[0].initializeApp, getApps = mods[0].getApps;
      var db_mod = mods[1];
      var cfg = { apiKey:"AIzaSyBmPL3mFJXFN3LXY_gPuH2HSJY8oWmyOJ4", authDomain:"sokoni-aeb26.firebaseapp.com", projectId:"sokoni-aeb26" };
      var app = getApps().find(function(a){ return a.name==='sp-sellers'; }) || initApp(cfg,'sp-sellers');
      var db = db_mod.getFirestore(app);
      db_mod.getDocs(db_mod.query(
        db_mod.collection(db,'shopSettings'),
        db_mod.where('featuredOnHome','==',true)
      )).then(function(snap){
        snap.forEach(function(d){
          var r = d.data();
          if(!SELLER_POOL.find(function(s){ return s.id===d.id; })){
            SELLER_POOL.unshift({
              id: d.id,
              name: r.shopName || 'Sokoni Seller',
              loc: r.location || 'Kenya',
              stars: '⭐'.repeat(Math.round(r.rating||5)),
              rating: (r.rating||4.8) + ' · ' + (r.totalSales||0) + ' Sales',
              tags: [r.category||'🏪 General'],
              cat: r.category || 'all',
              img: r.logoUrl || 'assets/Sokoni Logo.png',
              boosted: true
            });
          }
        });
      }).catch(function(){});
    }).catch(function(){});
  }

  /* ── Inject CSS once ── */
  function _injectCSS() {
    if(document.getElementById('_spCSS')) return;
    var s = document.createElement('style');
    s.id = '_spCSS';
    s.textContent = [
      '@keyframes _spPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.5)}}',
      '@keyframes _spGlow{0%,100%{box-shadow:0 0 0 2px rgba(113,255,0,0.4)}50%{box-shadow:0 0 0 4px rgba(113,255,0,0.8)}}',
      '._sp-glow{animation:_spGlow 1.5s ease-in-out infinite!important;}',
      '#_spLiveDot{width:7px;height:7px;border-radius:50%;background:#ff4444;display:inline-block;animation:_spPulse 1.2s ease-in-out infinite;}',
      '#_spLiveBadge{display:inline-flex;align-items:center;gap:5px;background:rgba(255,50,50,0.12);border:1px solid rgba(255,50,50,0.35);color:#ff6060;font-size:10px;font-weight:900;padding:3px 8px;border-radius:20px;vertical-align:middle;margin-left:8px;}',
      '#_spSellersBadge{display:inline-flex;align-items:center;gap:5px;background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.3);color:#71ff00;font-size:10px;font-weight:900;padding:3px 8px;border-radius:20px;vertical-align:middle;margin-left:8px;}',
      '#_spCtrl{display:flex;align-items:center;gap:8px;}',
      '#_spCtrl button{background:none;border:1px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.5);border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer;font-family:inherit;transition:all .2s;}',
      '#_spCtrl button:hover{border-color:rgba(113,255,0,0.4);color:#71ff00;}',
      '#_spCtrl button._sp-paused{border-color:rgba(255,100,0,0.4);color:#ff8844;}',
    ].join('');
    document.head.appendChild(s);
  }

  /* ── Toggle pause ── */
  function _togglePause() {
    _paused = !_paused;
    var btn = document.getElementById('_spPauseBtn');
    if(btn){ btn.textContent = _paused ? '▶ Resume' : '⏸ Pause'; btn.classList.toggle('_sp-paused', _paused); }
  }

  /* ── PUBLIC: init(productPool) ── */
  function init(productPool) {
    _injectCSS();
    _productPool = (productPool || []).sort(function(){ return Math.random()-0.5; });
    _loadFirestoreSellers();

    /* --- SELLERS SECTION --- */
    var sellerContainer = document.querySelector('.seller-section .seller-container');
    if(sellerContainer) {
      sellerContainer.id = '_spSellersGrid';
      /* Add LIVE + controls to the section title */
      var sellerH2 = document.querySelector('.seller-section .section-title h2');
      if(sellerH2 && !document.getElementById('_spSellersBadge')) {
        sellerH2.insertAdjacentHTML('beforeend',
          '<span id="_spSellersBadge"><span id="_spLiveDot"></span> ROTATING</span>');
        var sellerRow = document.querySelector('.seller-section .section-title');
        if(sellerRow && !document.getElementById('_spCtrl')) {
          sellerRow.insertAdjacentHTML('beforeend',
            '<div id="_spCtrl"><button id="_spPauseBtn" onclick="window.SokoniSpotlight.togglePause()">⏸ Pause</button></div>');
        }
      }
      _renderSellers();
      clearInterval(_sellerTimer);
      _sellerTimer = setInterval(_renderSellers, 7000);
    }

    /* --- PRODUCTS SECTION --- */
    if(_productPool.length > 8) {
      var prodTitle = document.querySelector('#productsContainer')
        ? document.querySelector('#productsContainer').closest('section')
        : null;
      if(!prodTitle) prodTitle = document.querySelector('.new-arrivals-section');
      var prodH2 = prodTitle ? prodTitle.querySelector('h2') : null;
      if(prodH2 && !document.getElementById('_spLiveBadge')) {
        prodH2.insertAdjacentHTML('beforeend',
          '<span id="_spLiveBadge"><span id="_spLiveDot2" style="width:7px;height:7px;border-radius:50%;background:#ff4444;display:inline-block;animation:_spPulse 1.2s ease-in-out infinite;"></span> LIVE <span id="_spPageBadge" style="opacity:.6;font-size:9px;">1/' + Math.ceil(_productPool.length/8) + '</span></span>');
      }
      clearInterval(_productTimer);
      _productTimer = setInterval(_rotateProducts, 10000);
    }

    /* --- STORIES SECTION --- */
    clearInterval(_storyTimer);
    _storyTimer = setInterval(_rotateStories, 4000);

    /* Pause rotation on user scroll/touch (resume after 15s idle) */
    var _idleTimer = null;
    function _onInteract() {
      _paused = true;
      clearTimeout(_idleTimer);
      _idleTimer = setTimeout(function(){ _paused = false; }, 15000);
    }
    document.addEventListener('touchstart', _onInteract, { passive:true });
    document.addEventListener('scroll',     _onInteract, { passive:true });
  }

  function _destroy() {
    clearInterval(_sellerTimer);  _sellerTimer  = null;
    clearInterval(_productTimer); _productTimer = null;
    clearInterval(_storyTimer);   _storyTimer   = null;
  }
  window.addEventListener('pagehide', _destroy, { once: true });

  return {
    init: init,
    togglePause: _togglePause,
    refresh: function(pool){ _productPool = pool; _productPage = 0; },
    destroy: _destroy
  };
})();
