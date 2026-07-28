/* ============================================================
   SOKONI SOCIAL — Store Card Generator + Social Sharing + Followers
   Supports: WhatsApp Status, Instagram Stories, Facebook, X, Telegram
   Web Share API (native OS sheet on mobile)
============================================================ */
;(function(window){
'use strict';

const BASE_URL = 'https://mysokoni.co.ke';

/* ═══════════════════════════════════════════════════════════
   1. CANVAS STORY CARD GENERATOR  (1080 × 1920 — Story ratio)
═══════════════════════════════════════════════════════════ */
function generateCard(opts, cb){
  const W=1080, H=1920;
  const c=document.createElement('canvas');
  c.width=W; c.height=H;
  const x=c.getContext('2d');

  /* Background */
  const bg=x.createLinearGradient(0,0,W,H);
  bg.addColorStop(0,'#060606');
  bg.addColorStop(0.45,'#071a00');
  bg.addColorStop(1,'#030d00');
  x.fillStyle=bg; x.fillRect(0,0,W,H);

  /* Top glow */
  const glow=x.createRadialGradient(W/2,0,0,W/2,0,900);
  glow.addColorStop(0,'rgba(113,255,0,0.18)');
  glow.addColorStop(1,'rgba(113,255,0,0)');
  x.fillStyle=glow; x.fillRect(0,0,W,900);

  /* Decorative grid lines */
  x.strokeStyle='rgba(113,255,0,0.04)'; x.lineWidth=1;
  for(let i=0;i<W;i+=120){ x.beginPath(); x.moveTo(i,0); x.lineTo(i,H); x.stroke(); }
  for(let j=0;j<H;j+=120){ x.beginPath(); x.moveTo(0,j); x.lineTo(W,j); x.stroke(); }

  /* SOKONI brand */
  x.textAlign='center';
  x.fillStyle='#71ff00';
  x.font='bold 96px "Arial Black",Arial,sans-serif';
  x.fillText('SOKONI', W/2, 180);
  x.fillStyle='rgba(113,255,0,0.5)';
  x.font='34px Arial,sans-serif';
  x.fillText('mysokoni.co.ke', W/2, 234);

  /* Divider line */
  x.strokeStyle='rgba(113,255,0,0.2)'; x.lineWidth=2;
  x.beginPath(); x.moveTo(120,270); x.lineTo(W-120,270); x.stroke();

  /* Card frame */
  _rr(x,60,310,W-120,980,36,'rgba(255,255,255,0.04)','rgba(113,255,0,0.18)',2);

  /* Avatar circle */
  x.save();
  x.beginPath(); x.arc(W/2,480,110,0,Math.PI*2); x.clip();
  x.fillStyle='rgba(113,255,0,0.15)'; x.fillRect(W/2-110,370,220,220);
  x.restore();
  x.strokeStyle='rgba(113,255,0,0.5)'; x.lineWidth=5;
  x.beginPath(); x.arc(W/2,480,110,0,Math.PI*2); x.stroke();
  /* Store emoji / initial */
  const initial=(opts.name||'S')[0].toUpperCase();
  x.fillStyle='#71ff00'; x.font='bold 120px Arial,sans-serif'; x.textAlign='center';
  x.fillText(initial, W/2, 520);

  /* Store name */
  const nm=opts.name||'My Store';
  x.fillStyle='#ffffff'; x.font=`bold ${nm.length>14?72:88}px "Arial Black",Arial,sans-serif`;
  x.fillText(nm, W/2, 660);

  /* Category badge */
  const cat=opts.category||opts.type||'Store';
  _rr(x,W/2-180,690,360,62,31,'rgba(113,255,0,0.1)','rgba(113,255,0,0.35)',1.5);
  x.fillStyle='#71ff00'; x.font='bold 34px Arial,sans-serif';
  x.fillText(cat, W/2, 730);

  /* Tagline / bio */
  if(opts.tagline){
    x.fillStyle='rgba(255,255,255,0.5)'; x.font='36px Arial,sans-serif';
    _wrapText(x, opts.tagline, W/2, 820, 860, 50);
  }

  /* Rating */
  if(opts.rating){
    const stars='★'.repeat(Math.round(opts.rating))+'☆'.repeat(5-Math.round(opts.rating));
    x.fillStyle='#fbbf24'; x.font='56px Arial,sans-serif';
    x.fillText(stars, W/2, 970);
    x.fillStyle='rgba(255,255,255,0.45)'; x.font='32px Arial,sans-serif';
    x.fillText(opts.rating+' rating'+(opts.reviews?' · '+opts.reviews+' reviews':''), W/2, 1020);
  }

  /* Follower count */
  if(opts.followers>0){
    x.fillStyle='rgba(113,255,0,0.6)'; x.font='bold 28px Arial,sans-serif';
    x.fillText('❤ '+opts.followers.toLocaleString()+' followers on SOKONI', W/2, 1065);
  }

  /* CTA button */
  _rr(x,120,1140,W-240,110,28,'#71ff00',null,0);
  x.fillStyle='#000000'; x.font='bold 44px "Arial Black",Arial,sans-serif';
  x.fillText('🛍️  Shop on SOKONI', W/2, 1208);

  /* Services / tags strip */
  if(opts.tags&&opts.tags.length){
    const tags=opts.tags.slice(0,4);
    const tw=(W-120)/tags.length;
    tags.forEach(function(t,i){
      _rr(x,60+i*tw+4,1290,tw-8,64,16,'rgba(255,255,255,0.05)','rgba(255,255,255,0.1)',1);
      x.fillStyle='rgba(255,255,255,0.6)'; x.font='28px Arial,sans-serif';
      x.fillText(t, 60+i*tw+tw/2, 1330);
    });
  }

  /* Social handles strip (if provided) */
  if(opts.socials&&opts.socials.length){
    var sy=H-290; x.fillStyle='rgba(255,255,255,0.05)'; x.fillRect(0,sy,W,60);
    x.fillStyle='rgba(255,255,255,0.4)'; x.font='26px Arial,sans-serif'; x.textAlign='center';
    x.fillText(opts.socials.slice(0,3).join('  ·  '), W/2, sy+38);
  }

  /* Bottom strip */
  _rr(x,0,H-220,W,220,0,'rgba(0,0,0,0.6)',null,0);
  x.fillStyle='rgba(113,255,0,0.8)'; x.font='bold 38px "Arial Black",Arial,sans-serif';
  x.fillText('🇰🇪 Kenya\'s Premier Marketplace', W/2, H-140);
  x.fillStyle='rgba(255,255,255,0.35)'; x.font='30px Arial,sans-serif';
  x.fillText('mysokoni.co.ke  |  Fast delivery  |  M-Pesa accepted', W/2, H-90);

  if(cb) cb(c.toDataURL('image/png'));
  return c;
}

function _rr(ctx,x,y,w,h,r,fill,stroke,sw){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r);
  ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r);
  ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
  if(fill){ctx.fillStyle=fill;ctx.fill();}
  if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=sw||1;ctx.stroke();}
}

function _wrapText(ctx,text,cx,y,maxW,lh){
  const words=text.split(' '); let line='';
  words.forEach(function(w){
    const test=line+w+' ';
    if(ctx.measureText(test).width>maxW&&line){ ctx.fillText(line.trim(),cx,y); line=w+' '; y+=lh; }
    else line=test;
  });
  if(line.trim()) ctx.fillText(line.trim(),cx,y);
}

/* ═══════════════════════════════════════════════════════════
   2. SHARE MODAL
═══════════════════════════════════════════════════════════ */
function openShareModal(opts){
  // Store opts globally to avoid HTML injection via JSON
  window.SokoniSocial._sd = opts;
  var existing=document.getElementById('_skSocModal');
  if(existing) existing.remove();

  var storeUrl = opts.url || (BASE_URL + '/store.html?id=' + encodeURIComponent(opts.id||''));
  var modal=document.createElement('div');
  modal.id='_skSocModal';
  modal.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;padding:14px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);';

  modal.innerHTML=
    '<div style="background:linear-gradient(135deg,#0e0e0e,#091400);border:1px solid rgba(113,255,0,0.22);border-radius:24px;width:100%;max-width:460px;max-height:92vh;overflow-y:auto;padding:24px;position:relative;scrollbar-width:thin;">' +

    /* Close */
    '<button type="button" onclick="document.getElementById(\'_skSocModal\').remove()" style="position:absolute;top:14px;right:14px;background:rgba(255,255,255,0.07);border:none;color:rgba(255,255,255,0.6);width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;font-family:inherit;line-height:1;">✕</button>' +

    /* Title */
    '<div style="font-size:20px;font-weight:900;color:white;margin-bottom:3px;">📣 Share '+(opts.type==='service'?'Your Services':'Your Store')+'</div>' +
    '<div style="font-size:12px;color:rgba(255,255,255,0.4);margin-bottom:18px;">Promote on social media & grow your followers</div>' +

    /* Card preview area */
    '<div id="_skCardArea" style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:16px;overflow:hidden;margin-bottom:14px;text-align:center;min-height:80px;display:flex;align-items:center;justify-content:center;">' +
      '<div id="_skCardLoading" style="color:rgba(255,255,255,0.35);padding:24px;font-size:13px;">⏳ Generating store card…</div>' +
    '</div>' +

    /* Save/Share card buttons */
    '<div id="_skCardBtns" style="display:none;gap:10px;margin-bottom:18px;">' +
      '<button type="button" onclick="window.SokoniSocial._nativeShare()" style="flex:1;padding:13px;background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.35);border-radius:12px;color:#71ff00;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;">📲 Share Card (WhatsApp Status / IG Story)</button>' +
      '<button type="button" onclick="window.SokoniSocial._downloadCard()" style="padding:13px 16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:12px;color:rgba(255,255,255,0.6);font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;min-width:50px;">💾</button>' +
    '</div>' +

    /* Social platform buttons */
    '<div style="font-size:10px;font-weight:900;color:rgba(255,255,255,0.35);letter-spacing:1.2px;text-transform:uppercase;margin-bottom:10px;">Share directly</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">' +
      _socialBtn('#25d366','rgba(37,211,102,0.12)','_wa','<svg width="16" height="16" viewBox="0 0 24 24" fill="#25d366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>','WhatsApp','window.SokoniSocial._share("wa")') +
      _socialBtn('#1877f2','rgba(24,119,242,0.12)','_fb','<svg width="16" height="16" viewBox="0 0 24 24" fill="#1877f2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>','Facebook','window.SokoniSocial._share("fb")') +
      _socialBtn('#ffffff','rgba(255,255,255,0.07)','_x','<svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>','X (Twitter)','window.SokoniSocial._share("x")') +
      _socialBtn('#0088cc','rgba(0,136,204,0.12)','_tg','<svg width="16" height="16" viewBox="0 0 24 24" fill="#0088cc"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.820 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>','Telegram','window.SokoniSocial._share("tg")') +
      _socialBtn('#ff0050','rgba(255,0,80,0.1)','_tt','<svg width="16" height="16" viewBox="0 0 24 24" fill="#ff0050"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.16 8.16 0 0 0 4.77 1.52V6.75a4.85 4.85 0 0 1-1-.06z"/></svg>','TikTok','window.SokoniSocial._share("tt")') +
    '</div>' +

    /* Copy link */
    '<button type="button" id="_skCopyBtn" onclick="window.SokoniSocial._copyLink()" style="width:100%;padding:11px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:rgba(255,255,255,0.6);font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:16px;">🔗 Copy Store Link</button>' +

    /* How-to guide */
    '<div style="background:rgba(37,211,102,0.05);border:1px solid rgba(37,211,102,0.15);border-radius:14px;padding:14px;">' +
      '<div style="font-size:12px;font-weight:900;color:#25d366;margin-bottom:8px;">📱 How to post to WhatsApp Status / Instagram Story</div>' +
      '<ol style="font-size:12px;color:rgba(255,255,255,0.45);line-height:1.9;margin:0;padding-left:18px;">' +
        '<li>Tap <strong style="color:rgba(255,255,255,0.75);">📲 Share Card</strong> above — select WhatsApp from the share sheet</li>' +
        '<li><strong style="color:rgba(255,255,255,0.75);">WhatsApp Status:</strong> In WhatsApp tap the image → "My Status"</li>' +
        '<li><strong style="color:rgba(255,255,255,0.75);">Instagram Story:</strong> Tap image → select Instagram → "Your Story"</li>' +
        '<li>Or <strong style="color:rgba(255,255,255,0.75);">💾 Download</strong> the card and post it manually as a Status/Story</li>' +
      '</ol>' +
    '</div>' +
    '</div>';

  document.body.appendChild(modal);
  modal.addEventListener('click',function(e){if(e.target===modal)modal.remove();});

  /* Generate card async */
  setTimeout(function(){
    try{
      var canvas=generateCard(opts,function(dataUrl){
        window.SokoniSocial._cardDataUrl=dataUrl;
        window.SokoniSocial._cardCanvas=canvas;
        var area=document.getElementById('_skCardArea');
        if(area){
          canvas.style.cssText='max-width:100%;display:block;border-radius:10px;';
          area.innerHTML='';
          area.appendChild(canvas);
        }
        var btns=document.getElementById('_skCardBtns');
        if(btns) btns.style.display='flex';
      });
    }catch(e){}
  },80);
}

function _socialBtn(color,bg,id,icon,label,onclick){
  return '<button type="button" id="'+id+'" onclick="'+onclick+'" style="padding:12px 10px;background:'+bg+';border:1px solid '+color.replace('#','rgba(')+'33);border-radius:12px;color:'+color+';font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:7px;">'+icon+' '+label+'</button>';
}

/* ═══════════════════════════════════════════════════════════
   3. SHARE ACTIONS
═══════════════════════════════════════════════════════════ */
function _getUrl(){
  var sd=window.SokoniSocial._sd||{};
  return sd.url||(BASE_URL+'/store.html?id='+encodeURIComponent(sd.id||''));
}

function _share(platform){
  var sd=window.SokoniSocial._sd||{};
  var url=_getUrl();
  var name=sd.name||'This store';
  var tag=sd.tagline||'Kenya\'s favourite marketplace';
  var waText='🛍️ Check out *'+name+'* on SOKONI!\n\n'+tag+'\n\n🔗 '+url+'\n\n_Fast delivery | M-Pesa accepted | 🇰🇪 Kenya_';
  var tw='🛍️ '+name+' — '+tag+' | '+url+' #SOKONI #Kenya #KenyaShopping';
  if(platform==='wa') window.open('https://api.whatsapp.com/send?text='+encodeURIComponent(waText),'_blank');
  else if(platform==='fb') window.open('https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(url),'_blank');
  else if(platform==='x') window.open('https://twitter.com/intent/tweet?text='+encodeURIComponent(tw),'_blank');
  else if(platform==='tg') window.open('https://t.me/share/url?url='+encodeURIComponent(url)+'&text='+encodeURIComponent('🛍️ '+name+' on SOKONI'),'_blank');
  else if(platform==='tt'){
    /* TikTok: download card + guide */
    _downloadCard();
    (window._skToast||alert)('📲 TikTok Steps:\n1. Your store card has been saved\n2. Open TikTok → + → Upload → select the saved card\n3. Add caption: "Shop my store on SOKONI 🛍️ '+url+'"\n4. Use hashtags: #SOKONI #KenyaShopping #OnlineShopping');
  }
}

function _nativeShare(){
  var sd=window.SokoniSocial._sd||{};
  var url=_getUrl();
  var canvas=window.SokoniSocial._cardCanvas;

  /* Try Web Share API with image file first (enables WhatsApp Status / IG Stories) */
  if(canvas && navigator.canShare){
    canvas.toBlob(function(blob){
      var file=new File([blob],'sokoni-'+( sd.name||'store').replace(/\s+/g,'-')+'.png',{type:'image/png'});
      if(navigator.canShare({files:[file]})){
        navigator.share({files:[file],title:sd.name||'SOKONI Store',text:'Check out '+(sd.name||'this store')+' on SOKONI!'}).catch(function(){});
        return;
      }
      /* Fallback: share URL only */
      _shareFallback(url, sd);
    },'image/png');
  } else if(navigator.share){
    _shareFallback(url, sd);
  } else {
    /* Desktop: just download the card */
    _downloadCard();
    var btn=document.getElementById('_skCardBtns');
    if(btn){ var msg=document.createElement('div'); msg.style.cssText='color:rgba(113,255,0,0.8);font-size:12px;margin-top:6px;text-align:center;'; msg.textContent='Card saved — post it as your WhatsApp Status or Instagram Story!'; btn.parentNode.insertBefore(msg,btn.nextSibling); }
  }
}

function _shareFallback(url, sd){
  navigator.share({title:sd.name||'SOKONI Store',text:'Check out '+(sd.name||'this store')+' on SOKONI!',url:url}).catch(function(){});
}

function _downloadCard(){
  var dataUrl=window.SokoniSocial._cardDataUrl;
  if(!dataUrl) return;
  var a=document.createElement('a');
  a.href=dataUrl;
  a.download='sokoni-store-card.png';
  a.click();
}

function _copyLink(){
  var url=_getUrl();
  var btn=document.getElementById('_skCopyBtn');
  function done(){ if(btn){btn.textContent='✅ Copied!';btn.style.color='#71ff00';setTimeout(function(){btn.textContent='🔗 Copy Store Link';btn.style.color='';},2200);} }
  if(navigator.clipboard){ navigator.clipboard.writeText(url).then(done).catch(function(){ _fallbackCopy(url); done(); }); }
  else { _fallbackCopy(url); done(); }
}

function _fallbackCopy(text){
  var el=document.createElement('textarea'); el.value=text; el.style.cssText='position:fixed;opacity:0;';
  document.body.appendChild(el); el.select(); try{document.execCommand('copy');}catch(e){} document.body.removeChild(el);
}

/* ═══════════════════════════════════════════════════════════
   4. FOLLOWERS SYSTEM — canonical, self-sufficient, entity-agnostic
   ONE model for EVERY followable entity (provider / store / shop / hub / future
   brand, service, …): follows/{uid}--{type}--{entityId}, matching the deployed rule
   and SokoniDB. Firestore is authoritative; localStorage is a UI cache only. Uses
   firebase.firestore() DIRECTLY — no SokoniDB dependency — so it works on every page
   (SokoniDB is absent on ~40 of them). Follower COUNTS are best-effort/UI-only, a
   deferred aggregation workstream; a count write never fails the follow.
═══════════════════════════════════════════════════════════ */
function _fUid(){ try{ return (window.firebase && firebase.auth && firebase.auth().currentUser || {}).uid || null; }catch(e){ return null; } }
function _fDb(){ try{ return (window.firebase && firebase.firestore) ? firebase.firestore() : null; }catch(e){ return null; } }
function _fKey(type,id){ return (type||'store')+'--'+String(id); }
function _fDocId(uid,type,id){ return uid+'--'+(type||'store')+'--'+String(id).replace(/[^a-zA-Z0-9]/g,'_'); }
function _fCache(){ try{ var v=JSON.parse(localStorage.getItem('sokoniFollowing')||'{}'); return (v && !Array.isArray(v)) ? v : {}; }catch(e){ return {}; } }
function _fCacheSet(m){ try{ localStorage.setItem('sokoniFollowing',JSON.stringify(m)); }catch(e){} }

/* Sync check for instant render — the UI cache (hydrated from Firestore on load). */
function isFollowing(id,type){ return !!_fCache()[_fKey(type,id)]; }

function _bumpCount(id,d){ try{ var c=JSON.parse(localStorage.getItem('sokoniFollowerCounts')||'{}'); c[id]=Math.max(0,(c[id]||0)+d); localStorage.setItem('sokoniFollowerCounts',JSON.stringify(c)); }catch(e){} }
function getFollowerCount(id){ try{ return JSON.parse(localStorage.getItem('sokoniFollowerCounts')||'{}')[id]||0; }catch(e){ return 0; } }

/* The ONE canonical write. Firestore authoritative + optimistic UI cache. */
function _writeFollow(type,id,name,on){
  var m=_fCache();
  if(on) m[_fKey(type,id)]={type:type||'store',entityId:String(id),entityName:name||'',followedAt:Date.now()}; else delete m[_fKey(type,id)];
  _fCacheSet(m); _bumpCount(id,on?1:-1);
  var uid=_fUid(), db=_fDb();
  if(!uid||!db) return Promise.resolve();
  var fid=_fDocId(uid,type,id), cid=(type||'store')+'--'+String(id), FV=firebase.firestore.FieldValue;
  /* Follower count is BEST-EFFORT (deferred aggregation) — it must never fail the follow. */
  db.collection('followerCounts').doc(cid).set({count:FV.increment(on?1:-1),type:type||'store',entityId:String(id),entityName:name||''},{merge:true}).catch(function(){});
  return on
    ? db.collection('follows').doc(fid).set({uid:uid,type:type||'store',entityId:String(id),entityName:name||'',createdAt:FV.serverTimestamp()},{merge:true}).catch(function(e){ console.warn('[social] follow write failed',e&&e.message); })
    : db.collection('follows').doc(fid).delete().catch(function(e){ console.warn('[social] unfollow write failed',e&&e.message); });
}

/* Back-compat wrappers (any external caller still works). */
function followStore(data){ _writeFollow(data.type,data.id,data.name,true); return getFollowerCount(data.id); }
function unfollowStore(id,type){ _writeFollow(type,id,'',false); return getFollowerCount(id); }

/* ONE entry point for every follow button — entity-agnostic via `type`. */
function toggleFollow(storeId,storeName,btn,type){
  if(!_fUid()){ if(confirm('Sign in to follow?')) location.href='login.html?next='+encodeURIComponent(location.pathname+location.search); return; }
  var willFollow=!isFollowing(storeId,type);
  _updateFollowBtn(btn,willFollow,getFollowerCount(storeId));   /* optimistic */
  var span=document.getElementById('_fcount_'+String(storeId).replace(/[^a-z0-9]/gi,'_'));
  if(span) span.textContent=getFollowerCount(storeId).toLocaleString()+' followers';
  _writeFollow(type,storeId,storeName,willFollow);   /* idempotent — safe even if the label was stale cross-device */
}

/* Cross-device hydration: load THIS user's follows from Firestore into the cache on
   load, then refresh any follow buttons on the page so they show the correct state on
   a new device. Uses a documentId prefix query (uid--…) so it stays within the existing
   per-doc read rule (no new rule). If denied/offline, the same-device cache still works. */
function _hydrateFollows(){
  var uid=_fUid(), db=_fDb(); if(!uid||!db||!document.querySelectorAll) return;
  var cache=_fCache();
  document.querySelectorAll('[data-follow-id]').forEach(function(el){
    var id=el.getAttribute('data-follow-id'), type=el.getAttribute('data-follow-type')||'store';
    db.collection('follows').doc(_fDocId(uid,type,id)).get().then(function(sn){
      var following=sn.exists, ck=_fKey(type,id);
      if(following) cache[ck]={type:type,entityId:String(id),entityName:'',followedAt:Date.now()}; else delete cache[ck];
      _fCacheSet(cache);
      _updateFollowBtn(el, following, getFollowerCount(id));
    }).catch(function(){});
  });
}

function _updateFollowBtn(btn,nowFollowing,count){
  if(!btn) return;
  btn.textContent=nowFollowing?'✓ Following':'+ Follow';
  btn.style.color=nowFollowing?'#71ff00':'rgba(255,255,255,0.7)';
  btn.style.borderColor=nowFollowing?'rgba(113,255,0,0.4)':'rgba(255,255,255,0.18)';
  btn.style.background=nowFollowing?'rgba(113,255,0,0.1)':'rgba(255,255,255,0.05)';
}

/* Render an inline follow button into a container element */
function renderFollowBtn(storeId,storeName,container,type){
  if(!container) return;
  var f=isFollowing(storeId,type);
  var count=getFollowerCount(storeId);
  var sid=storeId.replace(/[^a-z0-9]/gi,'_');
  container.innerHTML=
    '<button type="button" data-follow-id="'+_esc(storeId)+'" data-follow-type="'+_esc(type||'store')+'" onclick="window.SokoniSocial.toggleFollow(\''+_esc(storeId)+'\',\''+_esc(storeName)+'\',this,\''+_esc(type||'store')+'\')" '+
    'style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;border:1px solid '+(f?'rgba(113,255,0,0.4)':'rgba(255,255,255,0.18)')+';background:'+(f?'rgba(113,255,0,0.1)':'rgba(255,255,255,0.05)')+';color:'+(f?'#71ff00':'rgba(255,255,255,0.7)')+';font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;transition:all .18s;-webkit-tap-highlight-color:transparent;touch-action:manipulation;">'+(f?'✓ Following':'+ Follow')+'</button>' +
    (count>0?'<span id="_fcount_'+sid+'" style="font-size:11px;color:rgba(255,255,255,0.35);margin-left:5px;">'+count.toLocaleString()+' followers</span>':'');
}

function _esc(s){ return (s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

/* Send WhatsApp blast to followers (opens WA for each — limited by browser) */
function notifyFollowers(opts){
  var user=null; try{user=JSON.parse(localStorage.getItem('sokoniUser')||'null');}catch(e){}
  var sellerName=opts.name||( user&&user.name)||'Seller';
  var msg='🛍️ *'+sellerName+'* has an update for you on SOKONI!\n\n'+(opts.message||'New products and great deals available now!')+'\n\n🔗 '+(opts.url||BASE_URL)+'\n\n_Reply STOP to unsubscribe_';
  window.open('https://api.whatsapp.com/send?text='+encodeURIComponent(msg),'_blank');
}

/* ═══════════════════════════════════════════════════════════
   5. SELLER DASHBOARD SHARE PANEL (injected into seller.html)
═══════════════════════════════════════════════════════════ */
function initSellerSharePanel(){
  var target=document.getElementById('marketing-section');
  if(!target||document.getElementById('_skSharePanel')) return;

  var panel=document.createElement('div');
  panel.id='_skSharePanel';
  panel.style.cssText='margin-bottom:28px;padding:20px;background:rgba(113,255,0,0.04);border:1px solid rgba(113,255,0,0.18);border-radius:18px;';
  panel.innerHTML=
    '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px;">'+
      '<div>'+
        '<div style="font-size:15px;font-weight:900;color:white;margin-bottom:3px;">📣 Share My Store on Social Media</div>'+
        '<div style="font-size:12px;color:rgba(255,255,255,0.4);">Promote on WhatsApp Status, Instagram Stories, Facebook, X & more</div>'+
      '</div>'+
      '<div id="_skFollowerStat" style="text-align:right;"></div>'+
    '</div>'+
    '<div style="display:flex;gap:10px;flex-wrap:wrap;">'+
      '<button type="button" onclick="window.SokoniSocial._openSellerShare()" style="flex:1;min-width:160px;padding:13px 18px;background:linear-gradient(135deg,rgba(113,255,0,0.15),rgba(0,200,80,0.08));border:1px solid rgba(113,255,0,0.35);border-radius:14px;color:#71ff00;font-size:14px;font-weight:900;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:10px;-webkit-tap-highlight-color:transparent;">🎨 Generate & Share Store Card</button>'+
      '<button type="button" onclick="window.SokoniSocial._sellerNotifyFollowers()" style="padding:13px 18px;background:rgba(37,211,102,0.08);border:1px solid rgba(37,211,102,0.25);border-radius:14px;color:#25d366;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;">📲 WhatsApp Blast</button>'+
    '</div>';

  /* Insert before the first child of marketing-section content */
  var header=target.querySelector('.seller-section-header');
  if(header&&header.nextSibling) target.insertBefore(panel, header.nextSibling);
  else target.prepend(panel);

  _refreshSellerFollowerStat();
}

function _openSellerShare(){
  var profile=null;
  try{profile=JSON.parse(localStorage.getItem('sellerProfile')||'null');}catch(e){}
  var user=null;
  try{user=JSON.parse(localStorage.getItem('sokoniUser')||'null');}catch(e){}
  var prods=[];
  try{prods=JSON.parse(localStorage.getItem('sellerProducts')||'[]');}catch(e){}

  var name=(profile&&profile.shopName)||(user&&user.storeName)||(user&&user.name)||'My Store';
  var cat=(profile&&profile.category)||(user&&user.storeCategory)||'Shop';
  var bio=(profile&&profile.bio)||(user&&user.storeTagline)||'Quality products from Kenya\'s trusted seller';
  var tags=(prods.slice(0,4).map(function(p){return p.category||p.name}).filter(Boolean));
  var storeId=(profile&&profile.id)||(user&&user.uid)||'seller';

  /* Collect linked social handles */
  var socials=[];
  if(user){
    if(user.storeInstagram) socials.push('📸 @'+user.storeInstagram.replace('@',''));
    if(user.storeTikTok)    socials.push('🎵 @'+user.storeTikTok.replace('@',''));
    if(user.storeTwitter)   socials.push('𝕏 @'+user.storeTwitter.replace('@',''));
    if(user.storeFacebook)  socials.push('👤 '+user.storeFacebook);
  }

  openShareModal({
    id: storeId,
    name: name,
    category: cat,
    tagline: bio,
    tags: tags,
    socials: socials,
    followers: getFollowerCount(storeId),
    instagram: user&&user.storeInstagram,
    tiktok:    user&&user.storeTikTok,
    type: 'store'
  });
}

function _sellerNotifyFollowers(){
  var profile=null; try{profile=JSON.parse(localStorage.getItem('sellerProfile')||'null');}catch(e){}
  var user=null; try{user=JSON.parse(localStorage.getItem('sokoniUser')||'null');}catch(e){}
  var name=(profile&&profile.shopName)||(user&&user.name)||'My Store';
  var count=getFollowerCount((profile&&profile.id)||(user&&user.uid)||'seller');

  /* Prompt for message */
  var msg=window.prompt('Message to your '+(count||'')+'  followers:\n(Will be sent via WhatsApp)','🔥 New arrivals! Check out the latest deals in my store now!');
  if(!msg) return;
  notifyFollowers({name:name,message:msg,url:BASE_URL+'/seller.html'});
}

function _refreshSellerFollowerStat(){
  var stat=document.getElementById('_skFollowerStat');
  if(!stat) return;
  var profile=null; try{profile=JSON.parse(localStorage.getItem('sellerProfile')||'null');}catch(e){}
  var user=null; try{user=JSON.parse(localStorage.getItem('sokoniUser')||'null');}catch(e){}
  var storeId=(profile&&profile.id)||(user&&user.uid)||'seller';
  var count=getFollowerCount(storeId);
  stat.innerHTML='<div style="font-size:24px;font-weight:900;color:#71ff00;">'+count.toLocaleString()+'</div><div style="font-size:10px;color:rgba(255,255,255,0.35);font-weight:700;text-transform:uppercase;letter-spacing:.8px;">Followers</div>';
}

/* ═══════════════════════════════════════════════════════════
   6. PROVIDER SHARE BUTTON (injected into provider.html)
═══════════════════════════════════════════════════════════ */
function initProviderShare(){
  var actions=document.getElementById('_pvShareBtn');
  if(actions) return; /* already added */
  var actionsDiv=document.querySelector('.pv-header-actions');
  if(!actionsDiv) return;
  var btn=document.createElement('button');
  btn.type='button';
  btn.id='_pvShareBtn';
  btn.onclick=function(){ window.SokoniSocial._openProviderShare(); };
  btn.style.cssText='padding:8px 14px;background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.28);color:#71ff00;border-radius:10px;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:6px;-webkit-tap-highlight-color:transparent;';
  btn.innerHTML='📣 Share';
  actionsDiv.appendChild(btn);
}

function _openProviderShare(){
  var p=null; try{p=window._profile||JSON.parse(localStorage.getItem('sokoniProviderProfile')||'null');}catch(e){}
  if(!p){pvToast&&pvToast('Complete your profile first');return;}
  openShareModal({
    id: p.id||'provider',
    name: p.name||'My Services',
    category: p.category||'Services',
    tagline: p.bio||p.tagline||'Professional services in Kenya',
    rating: p.rating,
    reviews: p.reviewCount,
    followers: getFollowerCount(p.id||'provider'),
    tags: (p.skills||[]).slice(0,4),
    type: 'service'
  });
}

/* ═══════════════════════════════════════════════════════════
   7. SERVICES PAGE — inject follow into provider cards
═══════════════════════════════════════════════════════════ */
function patchServicesFollowBtns(){
  /* Called after renderProviders() runs — add follow row to each card */
  setTimeout(function(){
    document.querySelectorAll('.pv-card').forEach(function(card){
      if(card.querySelector('._skFollowRow')) return;
      var bookBtn=card.querySelector('.pv-book-btn');
      if(!bookBtn) return;
      var nameEl=card.querySelector('.pv-name');
      var nameText=(nameEl&&nameEl.textContent)||'Provider';
      /* Extract name cleanly (strip "Verified" badge text) */
      var name=nameText.replace(/✅.*$/,'').trim();
      var storeId='sv_'+name.replace(/\s+/g,'_').toLowerCase();

      var row=document.createElement('div');
      row.className='_skFollowRow';
      row.style.cssText='display:flex;align-items:center;gap:8px;margin-top:8px;';
      renderFollowBtn(storeId,name,row,'service');
      /* Insert AFTER the button container (pv-foot), not inside it */
      var foot=bookBtn.closest('.pv-foot')||bookBtn.parentNode;
      foot.parentNode.insertBefore(row,foot.nextSibling);
    });
  },100);
}

/* ═══════════════════════════════════════════════════════════
   8. AUTO-INIT
═══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded',function(){
  var page=location.pathname.split('/').pop();
  if(page==='seller.html'||page==='') initSellerSharePanel();
  if(page==='provider.html') initProviderShare();
});

/* Hydrate the follow cache from Firestore on auth-ready, so a follow made on ANOTHER
   device shows the correct state here. Runs once auth resolves; re-runs are cheap. */
try {
  if (window.firebase && firebase.auth) {
    firebase.auth().onAuthStateChanged(function(u){ if (u) { try { _hydrateFollows(); } catch(e){} } });
  }
} catch(e){}

/* ═══════════════════════════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════════════════════════ */
window.SokoniSocial={
  openShareModal:     openShareModal,
  generateCard:       generateCard,
  isFollowing:        isFollowing,
  followStore:        followStore,
  unfollowStore:      unfollowStore,
  toggleFollow:       toggleFollow,
  getFollowerCount:   getFollowerCount,
  hydrateFollows:     _hydrateFollows,
  renderFollowBtn:    renderFollowBtn,
  notifyFollowers:    notifyFollowers,
  patchServicesFollowBtns: patchServicesFollowBtns,
  initProviderShare:  initProviderShare,
  /* Internal helpers exposed for onclick attributes */
  _share:             _share,
  _nativeShare:       _nativeShare,
  _downloadCard:      _downloadCard,
  _copyLink:          _copyLink,
  _openSellerShare:   _openSellerShare,
  _sellerNotifyFollowers: _sellerNotifyFollowers,
  _openProviderShare: _openProviderShare,
  _sd:                null,
  _cardDataUrl:       null,
  _cardCanvas:        null
};

})(window);

