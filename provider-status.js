/**
 * provider-status.js
 * Reads sokoniProviderAvailability from localStorage and overlays
 * live Available / Busy / By Appointment badges on any provider card
 * that matches by phone number or name.
 * Include at the bottom of any hub page that renders provider cards.
 */
(function(){
'use strict';

function getAvailability(){
  try{ return JSON.parse(localStorage.getItem('sokoniProviderAvailability')||'{}'); }catch(e){ return {}; }
}

const STATUS_HTML = {
  available:   '<span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:800;padding:2px 7px;border-radius:20px;background:rgba(57,255,20,0.12);border:1px solid rgba(57,255,20,0.25);color:#39ff14;"><span style="width:6px;height:6px;border-radius:50%;background:#39ff14;box-shadow:0 0 5px rgba(57,255,20,0.7);animation:pvPulse 1.5s infinite;"></span>Available</span>',
  busy:        '<span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:800;padding:2px 7px;border-radius:20px;background:rgba(255,80,80,0.12);border:1px solid rgba(255,80,80,0.25);color:#ff6464;"><span style="width:6px;height:6px;border-radius:50%;background:#ff6464;"></span>Busy</span>',
  appointment: '<span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:800;padding:2px 7px;border-radius:20px;background:rgba(255,152,0,0.12);border:1px solid rgba(255,152,0,0.25);color:#ff9800;"><span style="width:6px;height:6px;border-radius:50%;background:#ff9800;"></span>By Appt.</span>',
};

/* Inject keyframe animation once */
if(!document.getElementById('pvStatusStyle')){
  const s=document.createElement('style');
  s.id='pvStatusStyle';
  s.textContent='@keyframes pvPulse{0%,100%{transform:scale(1);opacity:1;}50%{transform:scale(1.4);opacity:.6;}}';
  document.head.appendChild(s);
}

function overlayStatuses(){
  const av = getAvailability();
  if(!Object.keys(av).length) return;

  /* Build quick lookup by normalised phone & name */
  const byPhone = {}, byName = {};
  Object.values(av).forEach(p=>{
    if(p.phone) byPhone[p.phone.replace(/\s/g,'').replace(/^254/,'0')] = p;
    if(p.name)  byName[p.name.toLowerCase().trim()] = p;
  });

  /* Find all elements that look like a provider name then walk up to the card */
  const nameEls = document.querySelectorAll(
    '.provider-name, .pv-name, .sv-prov-name, .lc-name, .en-card-name, .hc-card-name, .turf-name, .leader-name, .team-name, .mc-name'
  );

  nameEls.forEach(el=>{
    const text = el.textContent.trim().toLowerCase();
    const profile = byName[text];
    if(!profile) return;
    /* Don't double-badge */
    if(el.querySelector('.pv-live-badge')) return;
    const badge = document.createElement('span');
    badge.className = 'pv-live-badge';
    badge.style.cssText = 'margin-left:6px;vertical-align:middle;';
    badge.innerHTML = STATUS_HTML[profile.status] || STATUS_HTML['available'];
    el.appendChild(badge);
    /* Also show manage link */
    const card = el.closest('[class*="card"],[class*="row"],[class*="item"]');
    if(card && !card.querySelector('.pv-manage-link')){
      const link = document.createElement('a');
      link.className = 'pv-manage-link';
      link.href = 'provider.html';
      link.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-left:8px;font-size:9px;font-weight:800;padding:2px 8px;border-radius:5px;background:rgba(113,255,0,0.07);border:1px solid rgba(113,255,0,0.18);color:rgba(113,255,0,0.7);text-decoration:none;vertical-align:middle;';
      link.textContent = '⚙️ Manage';
      el.appendChild(link);
    }
  });
}

/* Run after DOM is ready and after any dynamic renders */
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded', overlayStatuses);
} else {
  overlayStatuses();
}
/* Re-run after short delay to catch dynamically rendered cards */
setTimeout(overlayStatuses, 1200);
setTimeout(overlayStatuses, 3000);

/* Expose so hub pages can call after re-render */
window.overlayProviderStatuses = overlayStatuses;

})(window);
