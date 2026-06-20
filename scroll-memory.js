/**
 * SOKONI Scroll Memory — universal scroll-position saver/restorer.
 * Included on any page that needs "return to where you were" behavior.
 * Works independently of script.js. Keyed by pathname+search so each page
 * has its own position.
 */
(function(){
'use strict';
const KEY = 'skScroll_' + (location.pathname + location.search).replace(/[^a-z0-9]/gi,'_');

function save(){
  try{ sessionStorage.setItem(KEY, String(Math.round(window.scrollY))); }catch(e){}
}

function restore(){
  try{
    const y = Number(sessionStorage.getItem(KEY)||0);
    if(y > 80){
      requestAnimationFrame(()=>requestAnimationFrame(()=>window.scrollTo({top:y,behavior:'instant'})));
    }
  }catch(e){}
}

/* Save as user scrolls (debounced) */
let _t;
window.addEventListener('scroll',function(){
  clearTimeout(_t);
  _t = setTimeout(save, 200);
},{passive:true});

/* Save when leaving the page */
window.addEventListener('pagehide', save);
window.addEventListener('beforeunload', save);

/* Save before following any same-site link */
document.addEventListener('click',function(e){
  const a = e.target.closest('a[href]');
  if(!a) return;
  const href = a.getAttribute('href')||'';
  if(href && !href.startsWith('http') && !href.startsWith('//') && !href.startsWith('javascript') && !href.startsWith('#') && !href.startsWith('mailto')){
    save();
  }
},true);

/* Restore after content is ready — two attempts for async-rendered pages */
function tryRestore(){
  restore();
  setTimeout(restore, 350);
  setTimeout(restore, 800);
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', tryRestore);
} else {
  tryRestore();
}

/* Expose for manual call after async data renders */
window.sokoniSaveScroll    = save;
window.sokoniRestoreScroll = restore;
})();
