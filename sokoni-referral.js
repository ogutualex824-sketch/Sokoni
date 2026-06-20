/* sokoni-referral.js — Share & Earn affiliate engine for SOKONI
   Every user (buyer/seller/provider/driver) earns from sharing
   ============================================================= */
(function(w){
'use strict';

/* ── COMMISSION RATES (% of sale value that referrer earns) ── */
var RATES = {
  product:       5,   // product/cart purchase
  service:       8,   // booked service
  food:          6,   // food order
  restaurant:    6,
  car:           7,   // car rental
  hospital:      5,
  entertainment: 8,
  store:         5,   // general store referral
  default:       5
};

/* ── TIERS (cumulative earnings unlock labels) ── */
var TIERS = [
  { min:0,      label:'Starter',    color:'#9ca3af', icon:'🌱' },
  { min:500,    label:'Hustler',    color:'#fbbf24', icon:'🔥' },
  { min:2000,   label:'Influencer', color:'#71ff00', icon:'⚡' },
  { min:10000,  label:'Ambassador', color:'#c084fc', icon:'💎' },
  { min:50000,  label:'Champion',   color:'#f97316', icon:'🏆' }
];

/* ── STORAGE KEYS ── */
var KEY_USER  = 'sokoniUser';
var KEY_REF   = 'sokoniReferral';
var KEY_EARN  = 'sokoniAffiliateEarnings';
var KEY_HIST  = 'sokoniAffiliateHistory';

/* ── HELPERS ── */
function _g(k){ try{ return JSON.parse(localStorage.getItem(k)||'null'); }catch(e){ return null; } }
function _s(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }

function getUser(){ return _g(KEY_USER)||{}; }

/* ── REF CODE GENERATION ── */
function getRefCode(){
  var u = getUser();
  if(u.refCode) return u.refCode;
  var base = (u.name||u.phone||'GUEST').toUpperCase().replace(/[^A-Z0-9]/g,'').substring(0,6);
  var code = 'SK' + base + (Date.now()%10000);
  u.refCode = code;
  _s(KEY_USER, u);
  return code;
}

/* ── APPEND REF CODE TO ANY URL ── */
function getShareURL(url){
  var code = getRefCode();
  var sep  = url.indexOf('?') >= 0 ? '&' : '?';
  return url + sep + 'ref=' + code;
}

/* ── DETECT INCOMING REF ON PAGE LOAD ── */
function checkIncoming(){
  var params = new URLSearchParams(w.location.search);
  var ref    = params.get('ref');
  if(!ref) return;
  var stored = _g(KEY_REF);
  if(stored && stored.code) return; // already attributed
  _s(KEY_REF, { code: ref, arrivedAt: Date.now(), page: w.location.pathname });
}

/* ── RECORD A REFERRED PURCHASE (called from checkout/booking confirm) ── */
function recordReferredPurchase(opts){
  /* opts: { amount, type, itemName, orderId } */
  var attribution = _g(KEY_REF);
  if(!attribution || !attribution.code) return; // not a referred user
  if(attribution.converted) return; // only first purchase counts

  var type = (opts.type || 'default').toLowerCase();
  var pct  = RATES[type] || RATES.default;
  var earn = Math.round((opts.amount || 0) * pct / 100);
  if(earn <= 0) return;

  // Record conversion on referrer side (localStorage by referrer code = this device's own code)
  // In a real deployment this would fire a Firestore write to the referrer's doc
  attribution.converted = true;
  attribution.earnedAt  = Date.now();
  _s(KEY_REF, attribution);

  /* Award +50 loyalty points to the buyer for using a referral link */
  try {
    var refPts = 50;
    var pd = JSON.parse(localStorage.getItem('sokoniPoints')||'{"total":0,"history":[]}');
    pd.total = (pd.total || 0) + refPts;
    var today = new Date().toLocaleDateString('en-KE',{day:'numeric',month:'short',year:'numeric'});
    pd.history.unshift({points:refPts, orderId:opts.orderId||'', date:today, description:'🎁 Referral join bonus'});
    localStorage.setItem('sokoniPoints', JSON.stringify(pd));
  } catch(e){}

  // Notify admin / referrer via SokoniDB if available
  if(w.SokoniDB && w.SokoniDB.db){
    try{
      w.SokoniDB.db.collection('affiliateConversions').add({
        referrerCode: attribution.code,
        buyerId: getUser().uid || 'guest',
        amount:  opts.amount || 0,
        earnKES: earn,
        type:    type,
        itemName: opts.itemName || '',
        orderId:  opts.orderId || '',
        createdAt: Date.now()
      });
    }catch(e){}
  }
}

/* ── LOG OWN AFFILIATE EARNINGS (for referrers seeing their dashboard) ── */
function addEarning(opts){
  /* opts: { amount, type, itemName, buyerLabel, orderId } */
  var pct  = RATES[(opts.type||'default')] || RATES.default;
  var earn = Math.round((opts.amount||0) * pct / 100);
  if(earn <= 0) return;

  var earnings = _g(KEY_EARN) || { total: 0, pending: 0 };
  earnings.pending = (earnings.pending || 0) + earn;
  earnings.total   = (earnings.total   || 0) + earn;
  _s(KEY_EARN, earnings);

  var hist = _g(KEY_HIST) || [];
  hist.unshift({
    id:      'AFF' + Date.now(),
    earn:    earn,
    pct:     pct,
    amount:  opts.amount,
    type:    opts.type || 'product',
    item:    opts.itemName || 'Item',
    buyer:   opts.buyerLabel || 'Someone',
    status:  'pending',
    date:    new Date().toLocaleDateString('en-KE',{day:'numeric',month:'short',year:'numeric'})
  });
  if(hist.length > 200) hist = hist.slice(0,200);
  _s(KEY_HIST, hist);
}

/* ── EARNINGS SUMMARY ── */
function getEarnings(){
  var e = _g(KEY_EARN) || { total:0, pending:0 };
  return {
    total:   e.total   || 0,
    pending: e.pending || 0,
    paid:    (e.total||0) - (e.pending||0),
    tier:    getTier(e.total||0)
  };
}

function getHistory(){ return _g(KEY_HIST) || []; }

function getTier(totalEarned){
  var tier = TIERS[0];
  for(var i=0; i<TIERS.length; i++){
    if(totalEarned >= TIERS[i].min) tier = TIERS[i];
  }
  return tier;
}

/* ── SHARE A PRODUCT / STORE / SERVICE (opens share modal or native share) ── */
function shareProduct(opts){
  /* opts: { url, title, desc, type, amount, image } */
  var shareURL = getShareURL(opts.url || w.location.href);
  var text     = opts.title + (opts.desc ? ' — ' + opts.desc : '') + '\n\nOn SOKONI 🛍️ Kenya\'s #1 marketplace:\n' + shareURL + '\n\n#SOKONI #Kenya';

  if(navigator.share){
    navigator.share({ title: opts.title || 'SOKONI', text: text, url: shareURL }).catch(function(){});
    return;
  }
  // Fallback: open WhatsApp
  w.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
}

/* ── INJECT "SHARE & EARN" CHIP ONTO ANY PAGE ── */
function injectShareChip(opts){
  /* opts: { targetEl, url, title, desc, type, earning } */
  if(!opts || !opts.targetEl) return;
  var el = typeof opts.targetEl === 'string' ? document.querySelector(opts.targetEl) : opts.targetEl;
  if(!el) return;

  var pct  = RATES[(opts.type||'default')] || RATES.default;
  var earn = opts.earning ? 'KES ' + opts.earning : pct + '% cashback';

  var chip = document.createElement('div');
  chip.className = 'skr-chip';
  chip.innerHTML =
    '<span style="font-size:12px;font-weight:800;color:#71ff00;">💸 Share &amp; Earn ' + earn + '</span>' +
    '<button type="button" onclick="window.SokoniReferral.shareProduct({url:\''+encodeURIComponent(opts.url||w.location.href)+'\',title:\''+encodeURIComponent(opts.title||'Check this out on SOKONI')+'\',type:\''+opts.type+'\'})" style="padding:6px 14px;background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.25);border-radius:8px;color:#71ff00;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;flex-shrink:0;">📣 Share</button>';
  chip.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 14px;background:rgba(113,255,0,0.04);border:1px solid rgba(113,255,0,0.15);border-radius:10px;margin-top:10px;';

  el.appendChild(chip);
}

/* ── FLOATING "SHARE & EARN" BANNER (shown once per product page) ── */
function showEarnBanner(opts){
  if(document.getElementById('skrBanner')) return;
  var pct  = RATES[(opts&&opts.type)||'default'] || RATES.default;
  var b    = document.createElement('div');
  b.id     = 'skrBanner';
  b.innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
      '<span style="font-size:13px;font-weight:800;color:white;">💸 Share this &amp; earn <span style="color:#71ff00;">' + pct + '% cashback</span> when friends buy!</span>' +
      '<button type="button" id="skrBannerBtn" style="padding:8px 18px;background:linear-gradient(135deg,#71ff00,#4fc800);border:none;border-radius:9px;color:black;font-size:12px;font-weight:900;cursor:pointer;font-family:inherit;flex-shrink:0;">📣 Share Now</button>' +
      '<button type="button" onclick="document.getElementById(\'skrBanner\').remove()" style="background:none;border:none;color:rgba(255,255,255,0.35);font-size:18px;cursor:pointer;padding:0;flex-shrink:0;line-height:1;">×</button>' +
    '</div>';
  b.style.cssText='position:fixed;bottom:72px;left:0;right:0;padding:12px 20px;background:rgba(10,10,10,0.96);border-top:1px solid rgba(113,255,0,0.2);z-index:9000;backdrop-filter:blur(12px);';
  document.body.appendChild(b);
  document.getElementById('skrBannerBtn').addEventListener('click', function(){
    shareProduct(opts||{});
    b.remove();
  });
  setTimeout(function(){ if(b.parentNode) b.style.transition='opacity .5s'; b.style.opacity='0'; setTimeout(function(){b.remove();},500); }, 8000);
}

/* ── REFERRAL.HTML DASHBOARD RENDERER ── */
function renderDashboard(){
  var code = getRefCode();
  var base = w.location.hostname.includes('localhost') ? w.location.origin : 'https://mysokoni.co.ke';
  var link = base + '/index.html?ref=' + code;

  var e    = getEarnings();
  var hist = getHistory();
  var tier = e.tier;

  /* Referral link box */
  var inp = document.getElementById('refLinkInput');
  if(inp) inp.value = link;

  /* Upgrade stats boxes if present */
  _sid('statTotalEarned', 'KES ' + e.total.toLocaleString());
  _sid('statPendingEarned', 'KES ' + e.pending.toLocaleString());
  _sid('statPaidEarned', 'KES ' + e.paid.toLocaleString());
  _sid('statTier', tier.icon + ' ' + tier.label);

  /* Tier badge */
  var tb = document.getElementById('tierBadge');
  if(tb) tb.innerHTML = '<span style="color:'+tier.color+';">'+tier.icon+' '+tier.label+' Affiliate</span>';

  /* History table */
  var ht = document.getElementById('affHistory');
  if(ht){
    if(!hist.length){
      ht.innerHTML='<div style="color:rgba(255,255,255,0.25);font-size:13px;padding:20px 0;text-align:center;">No commissions yet — share links to start earning!</div>';
    } else {
      ht.innerHTML='<table class="rf-table"><thead><tr><th>Item</th><th>Sale</th><th>Your Cut</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
        hist.slice(0,50).map(function(h){
          return '<tr><td style="color:white;font-weight:700;">'+h.item+'</td><td>KES '+h.amount.toLocaleString()+'</td><td style="color:#71ff00;font-weight:800;">+KES '+h.earn+'</td><td><span class="status-pill '+(h.status==='paid'?'pill-complete':'pill-pending')+'">'+h.status+'</span></td><td>'+h.date+'</td></tr>';
        }).join('') +
      '</tbody></table>';
    }
  }

  /* Share buttons get updated with actual link */
  _attachShareBtns(link, code);
}

function _sid(id, val){
  var el = document.getElementById(id);
  if(el) el.textContent = val;
}

function _attachShareBtns(link, code){
  var msg = 'Hey! Shop on SOKONI — Kenya\'s #1 marketplace 🛍️ Use my link and get 10% off your first order:\n' + link + '\n#SOKONI #ShopKenya';
  var btn;
  btn = document.getElementById('rfBtnWA');
  if(btn) btn.onclick = function(){ w.open('https://wa.me/?text='+encodeURIComponent(msg),'_blank'); };
  btn = document.getElementById('rfBtnTW');
  if(btn) btn.onclick = function(){ w.open('https://twitter.com/intent/tweet?text='+encodeURIComponent(msg),'_blank'); };
  btn = document.getElementById('rfBtnTG');
  if(btn) btn.onclick = function(){ w.open('https://t.me/share/url?url='+encodeURIComponent(link)+'&text='+encodeURIComponent('Shop on SOKONI Kenya! Use my link: '+link),'_blank'); };
  btn = document.getElementById('rfBtnFB');
  if(btn) btn.onclick = function(){ w.open('https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(link),'_blank'); };
  btn = document.getElementById('rfCopyBtn');
  if(btn) btn.onclick = function(){
    navigator.clipboard.writeText(link).then(function(){
      btn.textContent='✓ Copied!';
      setTimeout(function(){ btn.textContent='📋 Copy'; }, 2000);
    }).catch(function(){
      var t=document.createElement('textarea');t.value=link;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();
      btn.textContent='✓ Copied!';
      setTimeout(function(){ btn.textContent='📋 Copy'; }, 2000);
    });
  };
}

/* ── PATCH SOCIAL SHARE MODAL (sokoni-social.js) to embed ref code ── */
function patchSocialShare(){
  if(!w.SokoniSocial) return;
  var orig = w.SokoniSocial.openShareModal;
  if(!orig || orig._rfPatched) return;
  w.SokoniSocial.openShareModal = function(opts){
    if(opts && opts.shareURL){
      opts.shareURL = getShareURL(opts.shareURL);
    }
    orig.call(w.SokoniSocial, opts);
  };
  w.SokoniSocial.openShareModal._rfPatched = true;
}

/* ── PRODUCT PAGE: add "Share & Earn" chip below add-to-cart ── */
function initProductPage(){
  // Only runs on product.html
  if(!w.location.pathname.includes('product')) return;
  setTimeout(function(){
    var addCart = document.querySelector('.add-to-cart-btn,.pd-cart-btn,.btn-cart');
    if(addCart && addCart.parentNode){
      var p = window._currentProduct || {};
      injectShareChip({
        targetEl: addCart.parentNode,
        url: w.location.href,
        title: p.name || document.title,
        desc:  p.description || '',
        type:  'product'
      });
    }
  }, 500);
}

/* ── AUTO-INIT ── */
function init(){
  checkIncoming();
  if(w.location.pathname.includes('referral')){
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(renderDashboard, 100); });
  }
  document.addEventListener('DOMContentLoaded', function(){
    setTimeout(patchSocialShare, 800);
    initProductPage();
  });
}

init();

/* ── PUBLIC API ── */
w.SokoniReferral = {
  getRefCode:              getRefCode,
  getShareURL:             getShareURL,
  checkIncoming:           checkIncoming,
  recordReferredPurchase:  recordReferredPurchase,
  addEarning:              addEarning,
  getEarnings:             getEarnings,
  getHistory:              getHistory,
  getTier:                 getTier,
  shareProduct:            shareProduct,
  injectShareChip:         injectShareChip,
  showEarnBanner:          showEarnBanner,
  renderDashboard:         renderDashboard,
  RATES:                   RATES,
  TIERS:                   TIERS
};

})(window);
