/**
 * SOKONI Auto-Invoice System
 * Generates and shows a professional invoice modal after any transaction.
 * Saves to localStorage under 'sokoniInvoices'.
 * Auto-sends: WhatsApp to seller + Email to buyer & admin via Cloud Function.
 * Call: SokoniInvoice.generate(data) — see bottom for data shape.
 */

(function(){

  var ADMIN_EMAIL = 'orders@mysokoni.co.ke';

  /* ── Cloud Function email (SendGrid enterprise email service) ── */
  var CF_EMAIL_URL = 'https://us-central1-sokoni-aeb26.cloudfunctions.net/sendInvoiceEmail';
  function _sendEmailViaCF(toEmail, toName, inv){
    if(!toEmail) return;
    var payload = {
      data: {
        toEmail: toEmail,
        toName:  toName || 'Valued Customer',
        invoice: {
          ref:           inv.ref,
          date:          inv.date + ' at ' + inv.time,
          items:         inv.items || [],
          total:         inv.total,
          paymentMethod: inv.paymentMethod,
          sellerLine:    inv.sellerName ? 'Provider: ' + inv.sellerName : '',
        }
      }
    };
    /* onCall functions require a Firebase ID token — fetch it from auth if available */
    function _doFetch(token){
      var headers = { 'Content-Type': 'application/json' };
      if(token) headers['Authorization'] = 'Bearer ' + token;
      fetch(CF_EMAIL_URL, { method: 'POST', headers: headers, body: JSON.stringify(payload) })
        .then(function(r){ return r.json(); })
        .then(function(){ /* email dispatched */ })
        .catch(function(e){ console.warn('[SOKONI] CF email failed:', e); });
    }
    /* Try to get auth token via firebase.js global (window.firebaseAuth); fall through if unavailable */
    try {
      var _auth = window.firebaseAuth || null;
      var _user = _auth && _auth.currentUser;
      if(_user && typeof _user.getIdToken === 'function'){
        _user.getIdToken().then(_doFetch).catch(function(){ _doFetch(null); });
      } else {
        _doFetch(null);
      }
    } catch(e){ _doFetch(null); }
  }
  /* ── Inject styles once ── */
  if(!document.getElementById('sokoni-inv-styles')){
    var s=document.createElement('style');
    s.id='sokoni-inv-styles';
    s.textContent=`
/* ═══════════════════════════════
   SOKONI INVOICE MODAL
═══════════════════════════════ */
#sokoni-inv-overlay{
  position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);
  backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;
  padding:16px;animation:invFadeIn .25s ease;
}
@keyframes invFadeIn{from{opacity:0}to{opacity:1}}

#sokoni-inv-modal{
  background:#0a0a0a;border:1px solid rgba(113,255,0,0.25);border-radius:24px;
  max-width:480px;width:100%;max-height:90vh;overflow-y:auto;
  box-shadow:0 0 60px rgba(113,255,0,0.08);
  animation:invSlideUp .3s cubic-bezier(.22,1,.36,1);
}
@keyframes invSlideUp{from{transform:translateY(30px);opacity:0}to{transform:translateY(0);opacity:1}}

.inv-header{
  background:linear-gradient(135deg,rgba(113,255,0,0.1),rgba(113,255,0,0.03));
  border-bottom:1px solid rgba(113,255,0,0.15);border-radius:24px 24px 0 0;
  padding:20px 24px;display:flex;align-items:center;justify-content:space-between;
}
.inv-logo-wrap{display:flex;align-items:center;gap:10px;}
.inv-logo{height:32px;object-fit:contain;}
.inv-logo-text{font-size:18px;font-weight:900;color:#71ff00;letter-spacing:-.02em;}
.inv-header-right{text-align:right;}
.inv-ref{font-size:11px;color:rgba(255,255,255,0.35);font-weight:700;text-transform:uppercase;letter-spacing:.08em;}
.inv-ref-num{font-size:16px;font-weight:900;color:white;font-family:monospace;}

.inv-body{padding:20px 24px;}
.inv-title{font-size:11px;font-weight:900;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:14px;}

.inv-parties{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px;}
.inv-party-label{font-size:9px;color:rgba(255,255,255,0.3);text-transform:uppercase;font-weight:700;letter-spacing:.08em;margin-bottom:4px;}
.inv-party-name{font-size:13px;font-weight:800;color:white;}
.inv-party-sub{font-size:11px;color:rgba(255,255,255,0.4);margin-top:1px;}

.inv-divider{height:1px;background:rgba(255,255,255,0.06);margin:14px 0;}

.inv-items-header{display:grid;grid-template-columns:1fr auto auto;gap:8px;padding:0 0 6px;font-size:9px;font-weight:800;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:.08em;}
.inv-item{display:grid;grid-template-columns:1fr auto auto;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);align-items:center;}
.inv-item-name{font-size:13px;color:white;font-weight:600;}
.inv-item-cat{font-size:10px;color:rgba(255,255,255,0.35);}
.inv-item-qty{font-size:12px;color:rgba(255,255,255,0.5);text-align:center;}
.inv-item-price{font-size:13px;font-weight:800;color:#71ff00;text-align:right;white-space:nowrap;}

.inv-totals{margin-top:12px;}
.inv-total-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:12px;}
.inv-total-label{color:rgba(255,255,255,0.45);}
.inv-total-val{color:rgba(255,255,255,0.8);font-weight:700;}
.inv-grand-row{display:flex;justify-content:space-between;align-items:center;padding:12px 0 4px;border-top:1px solid rgba(113,255,0,0.2);margin-top:6px;}
.inv-grand-label{font-size:14px;font-weight:900;color:white;}
.inv-grand-val{font-size:18px;font-weight:900;color:#71ff00;}

.inv-payment-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(113,255,0,0.08);
  border:1px solid rgba(113,255,0,0.2);border-radius:99px;padding:6px 14px;
  font-size:11px;font-weight:800;color:#71ff00;margin:14px 0;}

.inv-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0;}
.inv-meta-box{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:10px 12px;}
.inv-meta-label{font-size:9px;color:rgba(255,255,255,0.3);text-transform:uppercase;font-weight:700;letter-spacing:.06em;margin-bottom:3px;}
.inv-meta-val{font-size:12px;font-weight:700;color:white;}

.inv-footer{
  background:rgba(255,255,255,0.02);border-top:1px solid rgba(255,255,255,0.06);
  border-radius:0 0 24px 24px;padding:14px 24px;text-align:center;
  font-size:10px;color:rgba(255,255,255,0.25);line-height:1.6;
}
.inv-footer b{color:rgba(255,255,255,0.4);}

.inv-actions{display:flex;gap:8px;padding:16px 24px 0;flex-wrap:wrap;}
.inv-btn{flex:1;padding:12px;border-radius:12px;border:none;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;transition:.15s;min-width:120px;}
.inv-btn-primary{background:rgba(113,255,0,0.15);border:1px solid rgba(113,255,0,0.3);color:#71ff00;}
.inv-btn-primary:hover{background:rgba(113,255,0,0.25);}
.inv-btn-secondary{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);}
.inv-btn-secondary:hover{background:rgba(255,255,255,0.1);}
.inv-btn-close{background:rgba(255,60,60,0.08);border:1px solid rgba(255,60,60,0.2);color:#ff6464;}
.inv-btn-close:hover{background:rgba(255,60,60,0.15);}

/* PRINT styles */
@media print{
  body > *:not(#sokoni-inv-overlay){display:none!important;}
  #sokoni-inv-overlay{position:static;background:white;padding:0;}
  #sokoni-inv-modal{max-height:none;box-shadow:none;border:none;color:#111;background:white;}
  .inv-header{background:#f5f5f5;border-color:#ddd;}
  .inv-logo-text,.inv-ref-num,.inv-party-name,.inv-grand-val{color:#000!important;}
  .inv-item-price,.inv-grand-val{color:#2a7a00!important;}
  .inv-actions,.inv-btn{display:none!important;}
  .inv-footer{background:#f9f9f9;border-color:#eee;}
}

@media(max-width:500px){
  #sokoni-inv-modal{border-radius:18px;margin:0;}
  .inv-parties{grid-template-columns:1fr;}
  .inv-meta{grid-template-columns:1fr;}
  .inv-body{padding:16px;}
  .inv-actions{padding:12px 16px 0;flex-direction:column;}
  .inv-btn{min-width:unset;}
}
    `;
    document.head.appendChild(s);
  }

  /* ── Core ── */
  var SokoniInvoice = {

    /**
     * generate(data) — call after any successful payment
     *
     * data = {
     *   type          : 'order' | 'booking' | 'ride' | 'service' | 'bnb' | 'subscription'
     *   buyerName     : string
     *   buyerPhone    : string
     *   buyerEmail    : string   (optional — triggers auto-email to buyer)
     *   items         : [{ name, category, qty, price }]
     *   subtotal      : number
     *   delivery      : number   (optional, default 0)
     *   discount      : number   (optional, default 0)
     *   total         : number
     *   paymentMethod : 'M-Pesa' | 'Card' | 'PayPal' | 'Cash'
     *   paymentRef    : string   (transaction ref)
     *   sellerName    : string   (optional)
     *   sellerPhone   : string   (optional — triggers auto-WhatsApp to seller)
     *   sellerEmail   : string   (optional — triggers auto-email to seller)
     *   date          : string   (optional, defaults to now)
     *   location      : string   (optional)
     *   notes         : string   (optional)
     * }
     */
    generate: function(data){
      var inv = this._buildInvoice(data);
      this._saveToHistory(inv);
      this._show(inv);
      this._sendNotifications(inv);
      return inv;
    },

    /* ── AUTO-NOTIFICATIONS ── */
    _sendNotifications: function(inv){
      var self = this;
      /* 1. Email buyer (if email known) */
      if(inv.buyerEmail) self._sendEmail(inv.buyerEmail, inv.buyerName, inv);
      /* 2. Email seller (if email known) */
      if(inv.sellerEmail) self._sendEmail(inv.sellerEmail, inv.sellerName, inv);
      /* 3. Always email admin */
      self._sendEmail(ADMIN_EMAIL, 'SOKONI Admin', inv);
      /* 4. WhatsApp seller (if phone known — opens silently in background tab) */
      if(inv.sellerPhone) self._notifySellerWA(inv);
    },

    _sendEmail: function(toEmail, toName, inv){
      if(!toEmail) return;
      _sendEmailViaCF(toEmail, toName, inv);
    },

    _sendEmailCF: function(toEmail, toName, inv){ _sendEmailViaCF(toEmail, toName, inv); },

    _notifySellerWA: function(inv){
      var phone = String(inv.sellerPhone).replace(/\D/g,'');
      if(!phone) return;
      var msg = '🧾 *SOKONI — New Booking Invoice*\n\n'
        +'*Invoice #* '+inv.ref+'\n'
        +'*Date:* '+inv.date+' at '+inv.time+'\n'
        +'*Client:* '+inv.buyerName+' · '+inv.buyerPhone+'\n\n'
        +'*Items:*\n'
        + inv.items.map(function(it){ return '  • '+(it.qty||1)+'× '+it.name+' — KES '+((it.price||0)*(it.qty||1)).toLocaleString(); }).join('\n')
        +'\n\n*Total: KES '+inv.total.toLocaleString()+'*\n'
        +'Payment: '+inv.paymentMethod+'\n\n'
        +'Powered by SOKONI — mysokoni.co.ke';
      /* Open in background tab — user may need to press Send on WhatsApp Web */
      var url = 'https://wa.me/'+phone+'?text='+encodeURIComponent(msg);
      var tab = window.open(url,'_blank','noopener,noreferrer');
      /* If popup blocked, inject a "Notify Seller" button in the modal instead */
      if(!tab || tab.closed || typeof tab.closed==='undefined'){
        var actionsEl = document.querySelector('.inv-actions');
        if(actionsEl && !document.getElementById('_invSellerWABtn')){
          var btn=document.createElement('button');
          btn.id='_invSellerWABtn';
          btn.className='inv-btn inv-btn-secondary';
          btn.textContent='💬 Notify Seller';
          btn.onclick=function(){ window.open(url,'_blank'); };
          actionsEl.insertBefore(btn, actionsEl.firstChild);
        }
      }
    },

    _buildInvoice: function(data){
      var now = new Date();
      var pad = function(n){ return n<10?'0'+n:n; };
      var dateStr = data.date || (now.getFullYear()+'-'+pad(now.getMonth()+1)+'-'+pad(now.getDate()));
      var timeStr = pad(now.getHours())+':'+pad(now.getMinutes());
      var ref = data.paymentRef || ('SKN-'+now.getFullYear()+pad(now.getMonth()+1)+pad(now.getDate())+'-'+Math.random().toString(36).substr(2,6).toUpperCase());
      var items = data.items || [];
      if(!items.length && data.productName){
        items = [{name:data.productName, category:data.category||'', qty:data.qty||1, price:data.total||data.amount||0}];
      }
      return {
        ref: ref,
        type: data.type || 'order',
        date: dateStr,
        time: timeStr,
        buyerName: data.buyerName || 'Valued Customer',
        buyerPhone: data.buyerPhone || '—',
        buyerEmail: data.buyerEmail || '',
        items: items,
        subtotal: data.subtotal || data.total || 0,
        delivery: data.delivery || 0,
        discount: data.discount || 0,
        total: data.total || 0,
        paymentMethod: data.paymentMethod || 'M-Pesa',
        sellerName:  data.sellerName  || 'SOKONI Marketplace',
        sellerPhone: data.sellerPhone || '',
        sellerEmail: data.sellerEmail || '',
        location: data.location || '',
        notes: data.notes || '',
        status: 'paid'
      };
    },

    _saveToHistory: function(inv){
      try{
        var history = JSON.parse(localStorage.getItem('sokoniInvoices')||'[]');
        history.unshift(inv);
        history = history.slice(0,50); /* keep last 50 */
        localStorage.setItem('sokoniInvoices', JSON.stringify(history));
      }catch(e){}
    },

    _show: function(inv){
      /* Remove any existing */
      var old = document.getElementById('sokoni-inv-overlay');
      if(old) old.remove();

      var typeLabels = {
        order:'Product Order', booking:'Service Booking', ride:'Ride Receipt',
        service:'Service Receipt', bnb:'Accommodation Booking', subscription:'Subscription'
      };
      var typeLabel = typeLabels[inv.type] || 'Receipt';

      var itemsHtml = inv.items.map(function(it){
        return '<div class="inv-item">'
          +'<div><div class="inv-item-name">'+esc(it.name||'Item')+'</div>'+(it.category?'<div class="inv-item-cat">'+esc(it.category)+'</div>':'')+'</div>'
          +'<div class="inv-item-qty">×'+(it.qty||1)+'</div>'
          +'<div class="inv-item-price">KES '+(((it.price||0)*(it.qty||1)).toLocaleString())+'</div>'
          +'</div>';
      }).join('');

      var metaHtml = '';
      if(inv.location) metaHtml += '<div class="inv-meta-box"><div class="inv-meta-label">Delivery To</div><div class="inv-meta-val">'+esc(inv.location)+'</div></div>';
      if(inv.notes) metaHtml += '<div class="inv-meta-box"><div class="inv-meta-label">Notes</div><div class="inv-meta-val">'+esc(inv.notes)+'</div></div>';

      var methodIcons = {'M-Pesa':'📱','Card':'💳','PayPal':'🅿️','Cash':'💵'};
      var methodIcon = methodIcons[inv.paymentMethod] || '💰';

      var html = '<div id="sokoni-inv-overlay" onclick="if(event.target===this)SokoniInvoice.close()">'
        +'<div id="sokoni-inv-modal">'

        /* HEADER */
        +'<div class="inv-header">'
          +'<div class="inv-logo-wrap">'
            +'<img src="assets/Sokoni Logo.png" class="inv-logo" onerror="this.style.display=\'none\'">'
            +'<span class="inv-logo-text">SOKONI</span>'
          +'</div>'
          +'<div class="inv-header-right">'
            +'<div class="inv-ref">'+typeLabel+' Invoice</div>'
            +'<div class="inv-ref-num">#'+inv.ref+'</div>'
            +'<div style="font-size:10px;color:rgba(255,255,255,0.3);margin-top:2px;">'+inv.date+' at '+inv.time+'</div>'
          +'</div>'
        +'</div>'

        /* BODY */
        +'<div class="inv-body">'

          +'<div class="inv-parties">'
            +'<div><div class="inv-party-label">Bill To</div>'
              +'<div class="inv-party-name">'+esc(inv.buyerName)+'</div>'
              +'<div class="inv-party-sub">'+esc(inv.buyerPhone)+'</div>'
              +(inv.buyerEmail?'<div class="inv-party-sub">'+esc(inv.buyerEmail)+'</div>':'')
            +'</div>'
            +'<div><div class="inv-party-label">From</div>'
              +'<div class="inv-party-name">'+esc(inv.sellerName)+'</div>'
              +'<div class="inv-party-sub">SOKONI Marketplace</div>'
              +'<div class="inv-party-sub">Nairobi, Kenya</div>'
            +'</div>'
          +'</div>'

          +'<div class="inv-divider"></div>'

          +'<div class="inv-title">Items</div>'
          +'<div class="inv-items-header"><span>Description</span><span>Qty</span><span>Amount</span></div>'
          +itemsHtml

          +'<div class="inv-totals">'
            +(inv.delivery>0?'<div class="inv-total-row"><span class="inv-total-label">Subtotal</span><span class="inv-total-val">KES '+inv.subtotal.toLocaleString()+'</span></div>':'')
            +(inv.delivery>0?'<div class="inv-total-row"><span class="inv-total-label">Delivery</span><span class="inv-total-val">KES '+inv.delivery.toLocaleString()+'</span></div>':'')
            +(inv.discount>0?'<div class="inv-total-row"><span class="inv-total-label">Discount</span><span class="inv-total-val" style="color:#ff6464;">− KES '+inv.discount.toLocaleString()+'</span></div>':'')
            +'<div class="inv-grand-row">'
              +'<span class="inv-grand-label">Total Paid</span>'
              +'<span class="inv-grand-val">KES '+inv.total.toLocaleString()+'</span>'
            +'</div>'
          +'</div>'

          +'<div class="inv-payment-badge">'+methodIcon+' Paid via '+esc(inv.paymentMethod)+' · Ref: '+esc(inv.ref)+'</div>'

          +(metaHtml?'<div class="inv-meta">'+metaHtml+'</div>':'')

        +'</div>'/* /inv-body */

        /* EMAIL ROW — shows if no email was provided */
        +(!inv.buyerEmail
          ? '<div style="padding:0 24px 4px;display:flex;gap:8px;align-items:center;">'
            +'<input id="_invEmailInput" type="email" placeholder="Enter email to receive invoice" '
            +'style="flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px 14px;color:#fff;font-size:12px;font-family:inherit;outline:none;" />'
            +'<button onclick="SokoniInvoice.emailFromInput()" style="background:rgba(113,255,0,.12);border:1px solid rgba(113,255,0,.3);color:#71ff00;padding:10px 14px;border-radius:10px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap;">✉️ Send</button>'
            +'</div>'
          : '')

        /* ACTIONS */
        +'<div class="inv-actions">'
          +'<button class="inv-btn inv-btn-primary" onclick="SokoniInvoice.download()">📥 Download</button>'
          +'<button class="inv-btn inv-btn-secondary" onclick="SokoniInvoice.share()">📤 Share</button>'
          +'<button class="inv-btn inv-btn-close" onclick="SokoniInvoice.close()">✕ Close</button>'
        +'</div>'

        /* FOOTER */
        +'<div class="inv-footer">'
          +'Thank you for shopping on <b>SOKONI</b> — Kenya\'s Premium Marketplace<br>'
          +'Questions? <b>support@mysokoni.co.ke</b> · <b>0800-SOKONI</b><br>'
          +'<span style="font-size:9px;">This is an electronically generated receipt. No signature required.</span>'
        +'</div>'

        +'</div>'/* /modal */
        +'</div>';/* /overlay */

      document.body.insertAdjacentHTML('beforeend', html);
      this._currentInv = inv;
    },

    emailFromInput: function(){
      var input = document.getElementById('_invEmailInput');
      if(!input || !input.value.includes('@')){ if(input) input.style.borderColor='#ef4444'; return; }
      var inv = this._currentInv;
      if(!inv) return;
      inv.buyerEmail = input.value.trim();
      this._sendEmail(inv.buyerEmail, inv.buyerName, inv);
      input.disabled=true;
      input.value='✅ Invoice sent to '+inv.buyerEmail;
      input.style.color='#71ff00';
    },

    close: function(){
      var el = document.getElementById('sokoni-inv-overlay');
      if(el){
        el.style.opacity='0';
        el.style.transition='opacity .2s';
        setTimeout(function(){ el.remove(); },220);
      }
    },

    download: function(){
      window.print();
    },

    share: function(){
      var inv = this._currentInv;
      if(!inv) return;
      var text = '🧾 *SOKONI Invoice #'+inv.ref+'*\n'
        +'Date: '+inv.date+'\n'
        +'Items: '+inv.items.map(function(it){ return it.name; }).join(', ')+'\n'
        +'*Total: KES '+inv.total.toLocaleString()+'*\n'
        +'Payment: '+inv.paymentMethod+'\n\n'
        +'Powered by SOKONI — mysokoni.co.ke';
      if(window.SokoniShare){
        SokoniShare.open({
          name: 'Invoice #'+inv.ref,
          price: inv.total,
          url: window.location.href,
          description: text
        });
      } else if(navigator.share){
        navigator.share({title:'SOKONI Invoice #'+inv.ref, text:text}).catch(function(){});
      } else {
        window.open('https://wa.me/?text='+encodeURIComponent(text),'_blank');
      }
    },

    /* Get invoice history */
    getHistory: function(){
      try{ return JSON.parse(localStorage.getItem('sokoniInvoices')||'[]'); }catch(e){ return []; }
    }
  };

  /* Escape HTML */
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  window.SokoniInvoice = SokoniInvoice;
})();
