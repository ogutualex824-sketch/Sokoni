/**
 * type-classify.js
 * Central GOODS vs SERVICES classification for the SOKONI platform.
 * Injects type badges, filters, and navigation cues site-wide.
 */
(function(){
'use strict';

/* ══ MASTER CLASSIFICATION MAP ══
   Every page and hub categorised as goods, services, or both.
*/
const PAGE_TYPES = {

  /* ════════════════════════════════════
     GOODS — physical & digital products
     you buy and receive / download
  ════════════════════════════════════ */
  'category.html':      { type:'goods', label:'All Products',            icon:'🛒', color:'#71ff00', colorBg:'rgba(113,255,0,0.1)',  colorBorder:'rgba(113,255,0,0.25)'  },
  'product.html':       { type:'goods', label:'Product',                 icon:'📦', color:'#71ff00', colorBg:'rgba(113,255,0,0.1)',  colorBorder:'rgba(113,255,0,0.25)'  },
  'cart.html':          { type:'goods', label:'Cart',                    icon:'🛒', color:'#71ff00', colorBg:'rgba(113,255,0,0.1)',  colorBorder:'rgba(113,255,0,0.25)'  },
  'checkout.html':      { type:'goods', label:'Checkout',                icon:'💳', color:'#71ff00', colorBg:'rgba(113,255,0,0.1)',  colorBorder:'rgba(113,255,0,0.25)'  },
  'wishlist.html':      { type:'goods', label:'Wishlist',                icon:'❤️', color:'#f472b6', colorBg:'rgba(244,114,182,0.1)',colorBorder:'rgba(244,114,182,0.25)' },
  'flashsale.html':     { type:'goods', label:'Flash Sale — Products',   icon:'⚡', color:'#ff9800', colorBg:'rgba(255,152,0,0.1)',  colorBorder:'rgba(255,152,0,0.25)'  },
  'tech-hub.html':       { type:'goods', label:'Digital Products',        icon:'💻', color:'#818cf8', colorBg:'rgba(129,140,248,0.1)',colorBorder:'rgba(129,140,248,0.25)' },
  'construction.html':  { type:'goods', label:'Building Materials',      icon:'🧱', color:'#fbbf24', colorBg:'rgba(251,191,36,0.1)', colorBorder:'rgba(251,191,36,0.25)' },
  'b2b.html':           { type:'goods', label:'Wholesale Products',      icon:'🤝', color:'#00aaff', colorBg:'rgba(0,170,255,0.1)',  colorBorder:'rgba(0,170,255,0.25)'  },
  'ministore.html':     { type:'goods', label:'Mini Store',              icon:'🏪', color:'#71ff00', colorBg:'rgba(113,255,0,0.1)',  colorBorder:'rgba(113,255,0,0.25)'  },
  'seller.html':        { type:'goods', label:'Seller Dashboard',        icon:'🏪', color:'#71ff00', colorBg:'rgba(113,255,0,0.1)',  colorBorder:'rgba(113,255,0,0.25)'  },
  'track.html':         { type:'goods', label:'Order Tracking',          icon:'📦', color:'#71ff00', colorBg:'rgba(113,255,0,0.1)',  colorBorder:'rgba(113,255,0,0.25)'  },

  /* ════════════════════════════════════
     SERVICES — something done for you,
     booked, hired, or experienced
  ════════════════════════════════════ */
  'services.html':      { type:'services', label:'All Services',         icon:'⚙️', color:'#00aaff', colorBg:'rgba(0,170,255,0.1)',  colorBorder:'rgba(0,170,255,0.25)'  },
  'provider.html':      { type:'services', label:'Provider Dashboard',   icon:'⚙️', color:'#00aaff', colorBg:'rgba(0,170,255,0.1)',  colorBorder:'rgba(0,170,255,0.25)'  },
  'healthcare.html':    { type:'services', label:'Healthcare Services',  icon:'🏥', color:'#00c878', colorBg:'rgba(0,200,120,0.1)',  colorBorder:'rgba(0,200,120,0.25)'  },
  'legal-hub.html':     { type:'services', label:'Legal Services',       icon:'⚖️', color:'#a78bfa', colorBg:'rgba(167,139,250,0.1)',colorBorder:'rgba(167,139,250,0.25)' },
  'entertainment.html': { type:'services', label:'Entertainment',        icon:'🎧', color:'#c084fc', colorBg:'rgba(192,132,252,0.1)',colorBorder:'rgba(192,132,252,0.25)' },
  'sports-hub.html':    { type:'services', label:'Sports & Facilities',  icon:'⚽', color:'#39ff14', colorBg:'rgba(57,255,20,0.1)',  colorBorder:'rgba(57,255,20,0.25)'  },
  'mechanics.html':     { type:'services', label:'Mechanic Services',    icon:'🔧', color:'#f97316', colorBg:'rgba(249,115,22,0.1)', colorBorder:'rgba(249,115,22,0.25)' },
  'marketing.html':     { type:'services', label:'Marketing Services',   icon:'📢', color:'#fb923c', colorBg:'rgba(251,146,60,0.1)', colorBorder:'rgba(251,146,60,0.25)' },
  'driver.html':        { type:'services', label:'Delivery Service',     icon:'🛵', color:'#71ff00', colorBg:'rgba(113,255,0,0.1)',  colorBorder:'rgba(113,255,0,0.25)'  },
  'banking.html':       { type:'services', label:'Financial Services',   icon:'🏦', color:'#f59e0b', colorBg:'rgba(245,158,11,0.1)', colorBorder:'rgba(245,158,11,0.25)' },
  'car-rental.html':    { type:'services', label:'Car Hire — Service',   icon:'🚘', color:'#f97316', colorBg:'rgba(249,115,22,0.1)', colorBorder:'rgba(249,115,22,0.25)' },
  'bnb.html':           { type:'services', label:'BnB Accommodation',    icon:'🏡', color:'#00c878', colorBg:'rgba(0,200,120,0.1)',  colorBorder:'rgba(0,200,120,0.25)'  },
  'bnb-manage.html':    { type:'services', label:'BnB Management',       icon:'🏡', color:'#00c878', colorBg:'rgba(0,200,120,0.1)',  colorBorder:'rgba(0,200,120,0.25)'  },
  'landlord.html':      { type:'services', label:'Property Management',  icon:'🏠', color:'#00aaff', colorBg:'rgba(0,170,255,0.1)',  colorBorder:'rgba(0,170,255,0.25)'  },
  'delivery.html':      { type:'services', label:'Delivery Management',  icon:'🚚', color:'#71ff00', colorBg:'rgba(113,255,0,0.1)',  colorBorder:'rgba(113,255,0,0.25)'  },

  /* ════════════════════════════════════
     BOTH — pages that have a mix of
     products to buy AND services to book
  ════════════════════════════════════ */
  'food.html':          { type:'both', label:'Food — Order & Dine',      icon:'🍽️', color:'#ef4444', colorBg:'rgba(239,68,68,0.1)',  colorBorder:'rgba(239,68,68,0.25)'  },
  'car-hub.html':       { type:'both', label:'Car Hub — Buy & Service',  icon:'🚗', color:'#f97316', colorBg:'rgba(249,115,22,0.1)', colorBorder:'rgba(249,115,22,0.25)' },
  'property.html':      { type:'both', label:'Property — Buy & Rent',    icon:'🏠', color:'#00aaff', colorBg:'rgba(0,170,255,0.1)',  colorBorder:'rgba(0,170,255,0.25)'  },
};

/* Type display config */
const TYPE_DISPLAY = {
  goods:    { label:'GOODS',    icon:'🛒', color:'#71ff00', bg:'rgba(113,255,0,0.1)',   border:'rgba(113,255,0,0.25)'   },
  services: { label:'SERVICES', icon:'⚙️', color:'#00aaff', bg:'rgba(0,170,255,0.1)',   border:'rgba(0,170,255,0.25)'   },
  both:     { label:'GOODS + SERVICES', icon:'🔀', color:'#c084fc', bg:'rgba(192,132,252,0.1)', border:'rgba(192,132,252,0.25)' },
};

/* ══ INJECT GLOBAL STYLES ══ */
function injectStyles(){
  if(document.getElementById('tcStyles')) return;
  const s = document.createElement('style');
  s.id = 'tcStyles';
  s.textContent = `
    .tc-badge{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:800;padding:2px 8px;border-radius:20px;white-space:nowrap;letter-spacing:.04em;text-transform:uppercase;}
    .tc-badge-goods{background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.25);color:#71ff00;}
    .tc-badge-services{background:rgba(0,170,255,0.1);border:1px solid rgba(0,170,255,0.25);color:#00aaff;}
    .tc-badge-both{background:rgba(192,132,252,0.1);border:1px solid rgba(192,132,252,0.25);color:#c084fc;}

    /* Page-level type banner injected at top of body */
    .tc-page-banner{display:flex;align-items:center;gap:10px;padding:8px 20px;font-size:12px;font-weight:700;border-bottom:1px solid;position:relative;z-index:50;flex-wrap:wrap;}
    .tc-page-banner a{font-size:11px;font-weight:700;text-decoration:none;opacity:.7;margin-left:auto;}
    .tc-page-banner a:hover{opacity:1;}

    /* Hub card type strip at bottom */
    .tc-hub-strip{display:flex;align-items:center;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.05);}

    /* Type selector bar (for pages with both) */
    .tc-type-bar{display:flex;gap:6px;padding:10px 20px;background:rgba(255,255,255,0.02);border-bottom:1px solid rgba(255,255,255,0.06);overflow-x:auto;scrollbar-width:none;}
    .tc-type-bar::-webkit-scrollbar{display:none;}
    .tc-type-pill{flex-shrink:0;padding:7px 16px;border-radius:20px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);color:rgba(255,255,255,0.5);font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;text-decoration:none;display:inline-flex;align-items:center;gap:5px;}
    .tc-type-pill:hover{background:rgba(255,255,255,0.07);color:white;}
    .tc-type-pill.goods-active{background:rgba(113,255,0,0.1);border-color:rgba(113,255,0,0.3);color:#71ff00;}
    .tc-type-pill.services-active{background:rgba(0,170,255,0.1);border-color:rgba(0,170,255,0.3);color:#00aaff;}
    .tc-type-pill.both-active{background:rgba(192,132,252,0.1);border-color:rgba(192,132,252,0.3);color:#c084fc;}
  `;
  document.head.appendChild(s);
}

/* ══ GET CURRENT PAGE TYPE ══ */
function getCurrentPageInfo(){
  const page = location.pathname.split('/').pop() || 'index.html';
  return PAGE_TYPES[page] || null;
}

/* ══ INJECT PAGE-LEVEL BANNER ══ */
function injectPageBanner(){
  const info = getCurrentPageInfo(); if(!info) return;
  const td = TYPE_DISPLAY[info.type];
  const nav = document.querySelector('nav, .sh-nav, .pv-nav, .hc-nav, .en-nav, .mc-nav, .law-nav, .rd-nav, .sub-nav, .seller-navbar');
  if(!nav || document.querySelector('.tc-page-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'tc-page-banner';
  banner.style.cssText = `background:${td.bg};border-color:${td.border};color:${td.color};`;
  banner.innerHTML = `<span>${td.icon}</span><span style="color:white;font-weight:900;">${info.label}</span><span class="tc-badge tc-badge-${info.type}">${td.label}</span>`
    + (info.type==='goods'    ? `<a href="services.html" style="color:rgba(0,170,255,0.8);">⚙️ Find Services →</a>` : '')
    + (info.type==='services' ? `<a href="category.html?cat=all" style="color:rgba(113,255,0,0.8);">🛒 Shop Products →</a>` : '')
    + (info.type==='both'     ? `<a href="category.html?cat=all" style="color:rgba(113,255,0,0.7);margin-right:10px;">🛒 Products</a><a href="services.html" style="color:rgba(0,170,255,0.7);">⚙️ Services</a>` : '');
  nav.insertAdjacentElement('afterend', banner);
}

/* ══ BADGE HUB CARDS ══
   Adds a GOODS / SERVICES / BOTH tag to any <a> or div that links to a known hub page.
*/
function badgeHubCards(){
  document.querySelectorAll('a[href], [data-hub]').forEach(el=>{
    if(el.querySelector('.tc-badge')) return; // already badged
    const href = el.getAttribute('href') || el.dataset.hub || '';
    const page = href.split('/').pop().split('?')[0];
    const info = PAGE_TYPES[page]; if(!info) return;
    const td = TYPE_DISPLAY[info.type];
    /* Only badge elements that look like cards (have some height/content) */
    const isCard = el.classList.toString().match(/card|hub|tile|feat|item|link/i) || el.querySelector('h3,h4,.hub-icon,.th-card-icon');
    if(!isCard) return;
    const badge = document.createElement('span');
    badge.className = `tc-badge tc-badge-${info.type}`;
    badge.textContent = td.icon + ' ' + td.label;
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-top:6px;';
    /* Append inside card */
    const target = el.querySelector('p, .hub-arrow, h3+p, h4+p') || el;
    target.insertAdjacentElement('afterend', badge);
  });
}

/* ══ INJECT GOODS/SERVICES SWITCHER BAR ══
   For pages like services.html that show both hub types.
*/
function injectTypeSwitcher(){
  const page = location.pathname.split('/').pop();
  if(page !== 'services.html' && page !== 'index.html') return;
  if(document.querySelector('.tc-type-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'tc-type-bar';
  bar.innerHTML = `
    <span style="font-size:9px;font-weight:900;color:rgba(113,255,0,0.6);padding:7px 4px 7px 0;flex-shrink:0;text-transform:uppercase;letter-spacing:.06em;">🛒&nbsp;Goods</span>
    <a class="tc-type-pill" href="category.html?cat=all">All Products</a>
    <a class="tc-type-pill" href="flashsale.html">⚡ Flash Sale</a>
    <a class="tc-type-pill" href="tech-hub.html">💻 Digital</a>
    <a class="tc-type-pill" href="b2b.html">🤝 Wholesale</a>
    <a class="tc-type-pill" href="construction.html">🧱 Materials</a>
    <span style="width:1px;height:20px;background:rgba(255,255,255,0.1);flex-shrink:0;margin:0 4px;align-self:center;"></span>
    <span style="font-size:9px;font-weight:900;color:rgba(0,170,255,0.6);padding:7px 4px;flex-shrink:0;text-transform:uppercase;letter-spacing:.06em;">⚙️&nbsp;Services</span>
    <a class="tc-type-pill" href="services.html">All Services</a>
    <a class="tc-type-pill" href="healthcare.html">🏥 Health</a>
    <a class="tc-type-pill" href="legal-hub.html">⚖️ Legal</a>
    <a class="tc-type-pill" href="entertainment.html">🎧 Events</a>
    <a class="tc-type-pill" href="mechanics.html">🔧 Auto</a>
    <a class="tc-type-pill" href="sports-hub.html">⚽ Sports</a>
    <a class="tc-type-pill" href="banking.html">🏦 Finance</a>
    <span style="width:1px;height:20px;background:rgba(255,255,255,0.1);flex-shrink:0;margin:0 4px;align-self:center;"></span>
    <span style="font-size:9px;font-weight:900;color:rgba(192,132,252,0.6);padding:7px 4px;flex-shrink:0;text-transform:uppercase;letter-spacing:.06em;">🔀&nbsp;Both</span>
    <a class="tc-type-pill" href="food.html">🍽️ Food</a>
    <a class="tc-type-pill" href="car-hub.html">🚗 Cars</a>
    <a class="tc-type-pill" href="property.html">🏠 Property</a>
    <a class="tc-type-pill" href="bnb.html">🏡 BnB</a>
  `;
  /* Highlight active */
  bar.querySelectorAll('.tc-type-pill').forEach(p=>{
    if(p.href.includes(page)) p.classList.add(PAGE_TYPES[page]?.type+'-active'||'goods-active');
  });
  /* Insert after the page banner or after first nav */
  const banner = document.querySelector('.tc-page-banner');
  const nav = banner || document.querySelector('nav, .sh-nav, .sv-hero, .hc-hero');
  if(nav) nav.insertAdjacentElement('afterend', bar);
  else document.body.prepend(bar);
}

/* ══ EXPOSE HELPERS ══ */
window.SokoniTypeClassify = {
  PAGE_TYPES,
  TYPE_DISPLAY,
  getBadgeHTML: function(page){
    const info = PAGE_TYPES[page]; if(!info) return '';
    const td = TYPE_DISPLAY[info.type];
    return `<span class="tc-badge tc-badge-${info.type}">${td.icon} ${td.label}</span>`;
  },
  getType: function(page){ return PAGE_TYPES[page]?.type || null; },
  refresh: function(){ badgeHubCards(); }
};

/* ══ RUN ══ */
function run(){
  injectStyles();
  injectPageBanner();
  badgeHubCards();
  injectTypeSwitcher();
  /* Re-run after dynamic renders */
  setTimeout(badgeHubCards, 800);
  setTimeout(badgeHubCards, 2500);
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
else run();

})(window);
