/* ============================================================
   SOKONI BnB HUB — sokoni-bnb.js
   window.SokoniBnB IIFE module
   Short Stay · Hotels · Guesthouses · Vacation Rentals · Serviced Apartments
============================================================ */
;(function(){
'use strict';

const _BNB_COLL = {
  listings:'bnbListings', bookings:'bnbBookings',
  reviews:'bnbReviews',  hosts:'bnbHosts',
};
function _db(){ try{ return window.firebase?.firestore ? window.firebase.firestore() : null; }catch(e){ return null; } }
function fsWrite(col, data) {
  const fsCol = _BNB_COLL[col];
  if (fsCol) {
    try {
      const db = _db();
      if (db) db.collection(fsCol).doc(data.id).set(data, {merge:true}).catch(e => console.warn('[BnB] Firestore write:', col, e));
    } catch(e) {}
  }
  try {
    const key='bnb_'+col; const arr=JSON.parse(localStorage.getItem(key)||'[]');
    const idx=arr.findIndex(x=>x.id===data.id);
    if(idx>-1) arr[idx]=data; else arr.unshift(data);
    localStorage.setItem(key, JSON.stringify(arr.slice(0,500)));
  } catch(e){}
}
function fsRead(col){ try{return JSON.parse(localStorage.getItem('bnb_'+col)||'[]');}catch(e){return[];} }
function uid(){ try{return JSON.parse(localStorage.getItem('sokoniUser')||'{}').uid||'guest';}catch(e){return'guest';} }

/* ── ACCOMMODATION TYPES ── */
const BNB_TYPES = [
  {id:'all',           label:'All Stays',          icon:'🏠'},
  {id:'airbnb',        label:'Airbnb / Apartment',  icon:'🌴'},
  {id:'hotel',         label:'Hotels',              icon:'🏨'},
  {id:'guesthouse',    label:'Guest Houses',        icon:'🏡'},
  {id:'serviced',      label:'Serviced Apartments', icon:'🏢'},
  {id:'vacation',      label:'Vacation Homes',      icon:'⛱️'},
  {id:'holiday',       label:'Holiday Homes',       icon:'🌅'},
  {id:'hostel',        label:'Hostels & Budgets',   icon:'🎒'},
];

/* ── BOOKING STATUS ── */
const BOOKING_STATUS = {
  pending:     {label:'Pending Confirmation', icon:'⏳', color:'#f59e0b'},
  confirmed:   {label:'Confirmed',            icon:'✅', color:'#22c55e'},
  checked_in:  {label:'Checked In',           icon:'🔑', color:'#00aaff'},
  checked_out: {label:'Completed',            icon:'🏁', color:'rgba(255,255,255,0.4)'},
  cancelled:   {label:'Cancelled',            icon:'❌', color:'#ef4444'},
};

/* ── AMENITIES ── */
const AMENITIES_MAP = {
  wifi:'📶 Free WiFi', pool:'🏊 Swimming Pool', ac:'❄️ Air Conditioning',
  breakfast:'🍳 Breakfast Included', parking:'🚗 Parking', gym:'💪 Gym',
  restaurant:'🍽️ Restaurant', bar:'🍸 Bar', spa:'💆 Spa', kitchen:'🍳 Full Kitchen',
  laundry:'👕 Laundry', security:'🛡️ 24hr Security', rooftop:'🏙️ Rooftop',
  balcony:'🏙️ Balcony', garden:'🌿 Garden', bbq:'🔥 BBQ Area',
  netflix:'📺 Netflix', workspace:'💻 Work Desk', pets:'🐾 Pets Allowed',
  ocean_view:'🌊 Ocean View', lake_view:'🏞️ Lake View', city_view:'🌆 City View',
  airport_transfer:'🚖 Airport Transfer', concierge:'🛎️ Concierge',
};

/* ── HOSTS ── */
const HOSTS = [
  {id:'hst001',name:'Coastal Homes Kenya',contact:'Fatuma Hassan',type:'agency',location:'Mombasa',phone:'0723 002 002',email:'info@coastalhomes.co.ke',verified:true,rating:4.8,reviews:89,listings:14,icon:'🌴',bio:'Mombasa\'s leading short-stay and beach property specialists. Airbnbs, beach houses and serviced apartments along the Kenyan coast.'},
  {id:'hst002',name:'Nairobi Stays',contact:'Grace Wanjiku',type:'agency',location:'Nairobi',phone:'0712 900 001',email:'info@nairobistays.co.ke',verified:true,rating:4.7,reviews:143,listings:28,icon:'🏙️',bio:'Premium serviced apartments and Airbnb-style stays in Nairobi\'s best neighbourhoods. Business and leisure guests welcome.'},
  {id:'hst003',name:'Lake Victoria Escapes',contact:'Ouma James',type:'individual',location:'Kisumu',phone:'0734 900 002',email:'ouma@lvescapes.co.ke',verified:true,rating:4.6,reviews:47,listings:8,icon:'🌊',bio:'Charming lakeside guesthouses and cottages in Kisumu and Homabay. Perfect for weekend escapes and business travel.'},
  {id:'hst004',name:'Rift Valley Retreats',contact:'Akinyi Sarah',type:'individual',location:'Nakuru',phone:'0745 900 003',email:'sarah@rvretreats.co.ke',verified:false,rating:4.4,reviews:31,listings:6,icon:'🦒',bio:'Scenic retreats near Lake Nakuru, Naivasha and Hell\'s Gate. Game drives, bird watching and lake views.'},
  {id:'hst005',name:'Diani Beach Properties',contact:'Mohamed Ali',type:'agency',location:'Kwale',phone:'0756 900 004',email:'info@dianiprop.co.ke',verified:true,rating:4.9,reviews:212,listings:22,icon:'🏖️',bio:'Diani Beach\'s premier accommodation provider. Beachfront villas, cottages and holiday apartments on Kenya\'s most beautiful stretch of coastline.'},
  {id:'hst006',name:'Mountain View Lodge',contact:'Njoroge Peter',type:'individual',location:'Nanyuki',phone:'0767 900 005',email:'peter@mvlodge.co.ke',verified:true,rating:4.7,reviews:58,listings:5,icon:'🏔️',bio:'Eco-lodge and cottage rentals at the foot of Mt. Kenya. Ideal for hikers, nature lovers and weekend retreats.'},
];

/* ── LISTINGS ── */
const LISTINGS = [
  /* ── AIRBNB / APARTMENT ── */
  {id:'b001',hostId:'hst002',hostName:'Nairobi Stays',type:'airbnb',title:'Luxury 2BR Airbnb in Kilimani with Rooftop Pool',location:'Kilimani, Nairobi',county:'nairobi',price:5500,priceUnit:'KES/night',minStay:2,maxGuests:4,bedrooms:2,bathrooms:2,size:110,furnished:true,amenities:['pool','wifi','parking','security','ac','cctv','netflix'],description:'Stunning fully-furnished 2-bedroom apartment in upmarket Kilimani. Shared rooftop pool. Walking distance to Yaya Centre and Village Market. Free WiFi, Netflix, AC in all rooms.',features:['Rooftop pool access','Smart TV / Netflix','High-speed WiFi','AC in all rooms','Secure parking','24hr security'],images:['🌴','🏊','🛋️'],icon:'🌴',featured:true,rating:4.9,reviews:67,checkInTime:'2:00 PM',checkOutTime:'11:00 AM'},
  {id:'b002',hostId:'hst002',hostName:'Nairobi Stays',type:'serviced',title:'Premium Serviced Studio — Westlands CBD',location:'Westlands, Nairobi',county:'nairobi',price:4200,priceUnit:'KES/night',minStay:1,maxGuests:2,bedrooms:1,bathrooms:1,size:60,furnished:true,amenities:['wifi','ac','parking','security','elevator','concierge','workspace'],description:'Hotel-quality serviced apartment in Westlands. Ideal for business travelers and corporate stays. Daily housekeeping, 24hr concierge, high-speed WiFi. Walking distance to major corporates.',features:['Daily housekeeping','Corporate billing available','High-speed WiFi','Dedicated parking','24hr concierge','Gym access'],images:['🏢','💼'],icon:'🏢',featured:false,rating:4.7,reviews:44,checkInTime:'3:00 PM',checkOutTime:'12:00 PM'},
  {id:'b003',hostId:'hst002',hostName:'Nairobi Stays',type:'airbnb',title:'Modern 1BR Apartment — Karen',location:'Karen, Nairobi',county:'nairobi',price:7000,priceUnit:'KES/night',minStay:2,maxGuests:2,bedrooms:1,bathrooms:1,size:75,furnished:true,amenities:['wifi','ac','garden','security','parking','kitchen'],description:'Beautiful 1-bedroom apartment in leafy Karen. Private garden, full kitchen, free WiFi. Walking distance to Karen Shopping Centre and Ololua Forest. Peaceful and secure.',features:['Private garden','Full kitchen','Free WiFi','Secure estate','Double parking','Quiet neighbourhood'],images:['🏡','🌿'],icon:'🏡',featured:true,rating:4.8,reviews:29,checkInTime:'2:00 PM',checkOutTime:'11:00 AM'},

  /* ── HOTELS ── */
  {id:'b004',hostId:'hst002',hostName:'Nairobi Stays',type:'hotel',title:'Boutique Hotel Room — Upper Hill',location:'Upper Hill, Nairobi',county:'nairobi',price:9500,priceUnit:'KES/night',minStay:1,maxGuests:2,bedrooms:1,bathrooms:1,furnished:true,amenities:['wifi','ac','restaurant','bar','gym','parking','breakfast','concierge'],description:'Elegant boutique hotel in Upper Hill\'s diplomatic zone. All rooms feature premium finishes. Breakfast included. On-site restaurant, bar and fitness center. Perfect for business and leisure.',features:['Breakfast included','On-site restaurant & bar','Fitness center','Business center','Airport transfer available','24hr room service'],images:['🏨'],icon:'🏨',featured:true,rating:4.6,reviews:112,checkInTime:'2:00 PM',checkOutTime:'12:00 PM'},

  /* ── BEACH / COAST ── */
  {id:'b005',hostId:'hst005',hostName:'Diani Beach Properties',type:'airbnb',title:'Beachfront Cottage — Diani Beach',location:'Diani Beach, Kwale',county:'mombasa',price:12000,priceUnit:'KES/night',minStay:2,maxGuests:4,bedrooms:2,bathrooms:2,furnished:true,amenities:['ocean_view','pool','wifi','ac','kitchen','security','beach_access'],description:'Wake up to the Indian Ocean from this stunning beachfront cottage. Direct beach access. Private pool. AC, free WiFi, full kitchen. Steps from Diani\'s best restaurants and water sports.',features:['Direct beach access','Private pool','Ocean views from all rooms','Full kitchen','AC','Water sports nearby'],images:['🏖️','🌊','🌴'],icon:'🏖️',featured:true,rating:4.9,reviews:87,checkInTime:'3:00 PM',checkOutTime:'11:00 AM'},
  {id:'b006',hostId:'hst001',hostName:'Coastal Homes Kenya',type:'vacation',title:'Beachfront Studio — Nyali Mombasa',location:'Nyali, Mombasa',county:'mombasa',price:6500,priceUnit:'KES/night',minStay:2,maxGuests:2,bedrooms:1,bathrooms:1,furnished:true,amenities:['ocean_view','pool','wifi','ac','balcony','security'],description:'Stylish studio with stunning Indian Ocean views from a private balcony. Shared pool. Steps from Nyali Beach and shopping. Free WiFi and AC. Ideal for couples.',features:['Ocean view balcony','Shared pool','Free WiFi','AC','Secure complex','Close to shops'],images:['🌊','🏖️'],icon:'🌊',featured:false,rating:4.7,reviews:53,checkInTime:'2:00 PM',checkOutTime:'11:00 AM'},
  {id:'b007',hostId:'hst005',hostName:'Diani Beach Properties',type:'holiday',title:'4BR Beachfront Villa — Diani',location:'Diani Beach, Kwale',county:'mombasa',price:45000,priceUnit:'KES/night',minStay:3,maxGuests:8,bedrooms:4,bathrooms:4,furnished:true,amenities:['ocean_view','pool','wifi','ac','kitchen','bbq','garden','security','concierge'],description:'Stunning 4-bedroom beachfront villa with direct Indian Ocean access. Private pool, large garden, BBQ terrace. Ideal for families and groups. Chef and housekeeper available. Truly a holiday paradise.',features:['Private pool','Direct beach access','Chef service available','BBQ terrace','4 en-suite bedrooms','Daily housekeeping'],images:['🏖️','🌴','🏊'],icon:'🏖️',featured:true,rating:5.0,reviews:34,checkInTime:'3:00 PM',checkOutTime:'11:00 AM'},

  /* ── LAKE / RIFT VALLEY ── */
  {id:'b008',hostId:'hst003',hostName:'Lake Victoria Escapes',type:'guesthouse',title:'Lakeside Guesthouse — Kisumu',location:'Kisumu Lake Basin',county:'kisumu',price:3500,priceUnit:'KES/night',minStay:1,maxGuests:2,bedrooms:1,bathrooms:1,furnished:true,amenities:['lake_view','wifi','breakfast','parking','garden'],description:'Charming guesthouse with direct Lake Victoria access. Breakfast included. Sunsets are extraordinary. Free WiFi and parking. Guided lake boat trips available. Great for birders and nature lovers.',features:['Lake Victoria access','Breakfast included','Sunset views','Guided boat trips','Free WiFi','Bird watching'],images:['🌊','🦅'],icon:'🌊',featured:false,rating:4.6,reviews:38,checkInTime:'2:00 PM',checkOutTime:'11:00 AM'},
  {id:'b009',hostId:'hst004',hostName:'Rift Valley Retreats',type:'holiday',title:'Lakeside Cottage — Lake Naivasha',location:'Lake Naivasha, Nakuru',county:'nakuru',price:8000,priceUnit:'KES/night',minStay:2,maxGuests:6,bedrooms:3,bathrooms:2,furnished:true,amenities:['lake_view','wifi','kitchen','bbq','garden','parking'],description:'Peaceful 3-bedroom cottage on the shores of Lake Naivasha. Private garden, BBQ, kayaks and bicycles for guest use. Flamingos, hippos and 400+ bird species. Perfect family getaway.',features:['Lake Naivasha access','Kayaks & bicycles included','Flamingo & hippo sightings','BBQ terrace','Full kitchen','Family-friendly'],images:['🌊','🦩'],icon:'🌊',featured:true,rating:4.8,reviews:62,checkInTime:'3:00 PM',checkOutTime:'11:00 AM'},

  /* ── MOUNTAIN / NANYUKI ── */
  {id:'b010',hostId:'hst006',hostName:'Mountain View Lodge',type:'guesthouse',title:'Mt. Kenya View Cottage — Nanyuki',location:'Nanyuki, Laikipia',county:'laikipia',price:5500,priceUnit:'KES/night',minStay:2,maxGuests:4,bedrooms:2,bathrooms:1,furnished:true,amenities:['city_view','wifi','breakfast','kitchen','garden','bbq'],description:'Cozy cottage with breathtaking Mt. Kenya views. Breakfast included. Full kitchen, BBQ, private garden. Close to Ol Pejeta Conservancy and Mt. Kenya trekking routes. Rhino, elephant and lion nearby.',features:['Mt. Kenya views','Breakfast included','BBQ terrace','Near Ol Pejeta','Hiking routes nearby','Full kitchen'],images:['🏔️','🌿'],icon:'🏔️',featured:false,rating:4.7,reviews:29,checkInTime:'2:00 PM',checkOutTime:'11:00 AM'},

  /* ── BUDGET / HOSTEL ── */
  {id:'b011',hostId:'hst002',hostName:'Nairobi Stays',type:'hostel',title:'Clean & Safe Hostel — Nairobi CBD',location:'Nairobi CBD, Nairobi',county:'nairobi',price:1200,priceUnit:'KES/night',minStay:1,maxGuests:1,bedrooms:0,bathrooms:0,furnished:true,amenities:['wifi','security','laundry','workspace'],description:'Clean, safe and social hostel in central Nairobi. Mixed and private dorm rooms available. Free WiFi, lockers, common kitchen and chill-out lounge. Great for backpackers and budget travelers.',features:['24hr check-in','Secure lockers','Free WiFi','Common kitchen','Travel info desk','Social atmosphere'],images:['🎒'],icon:'🎒',featured:false,rating:4.3,reviews:95,checkInTime:'2:00 PM',checkOutTime:'11:00 AM'},
  {id:'b012',hostId:'hst001',hostName:'Coastal Homes Kenya',type:'guesthouse',title:'Budget Guesthouse — Mombasa CBD',location:'Mombasa CBD, Mombasa',county:'mombasa',price:2500,priceUnit:'KES/night',minStay:1,maxGuests:2,bedrooms:1,bathrooms:1,furnished:true,amenities:['wifi','breakfast','ac','security','parking'],description:'Clean and affordable guesthouse in central Mombasa. Breakfast included. AC, free WiFi. Walking distance to ferry, Old Town, Fort Jesus and beaches. Great value in a central location.',features:['Breakfast included','AC','Free WiFi','Central location','Secure','Near Fort Jesus'],images:['🏡'],icon:'🏡',featured:false,rating:4.4,reviews:78,checkInTime:'12:00 PM',checkOutTime:'10:00 AM'},
];

/* ── LISTING FUNCTIONS ── */
function createListing(data) {
  const id = 'BNB' + Date.now();
  const listing = { id, ...data, hostId:data.hostId||uid(), rating:0, reviews:0, createdAt:Date.now() };
  const arr = fsRead('listings'); arr.unshift(listing);
  localStorage.setItem('bnb_listings', JSON.stringify(arr.slice(0,200)));
  fsWrite('listings', listing);
  return listing;
}

function getListings(filter) {
  const extra = fsRead('listings');
  let list = [...LISTINGS, ...extra];
  if (!filter) return list;
  if (filter.type && filter.type!=='all') list = list.filter(p=>p.type===filter.type);
  if (filter.county)   list = list.filter(p=>p.county?.toLowerCase().includes(filter.county.toLowerCase()));
  if (filter.minPrice) list = list.filter(p=>p.price>=filter.minPrice);
  if (filter.maxPrice) list = list.filter(p=>p.price<=filter.maxPrice);
  if (filter.bedrooms) list = list.filter(p=>p.bedrooms>=parseInt(filter.bedrooms));
  if (filter.maxGuests) list = list.filter(p=>p.maxGuests>=parseInt(filter.maxGuests));
  if (filter.q) {
    const q=filter.q.toLowerCase();
    list=list.filter(p=>(p.title+p.location+p.description+p.county+(p.amenities||[]).join(' ')).toLowerCase().includes(q));
  }
  if (filter.featured) list = list.filter(p=>p.featured);
  return list;
}

function getListingById(id) { return [...LISTINGS, ...fsRead('listings')].find(p=>p.id===id); }

/* ── BOOKING FUNCTIONS ── */
function createBooking(data) {
  const id = 'BK' + Date.now();
  const nights = Math.ceil((new Date(data.checkOut)-new Date(data.checkIn))/(1000*60*60*24));
  const booking = { id, ...data, nights, total:(data.price||0)*nights, status:'pending', createdAt:Date.now(), uid:uid(), ref:'SOKBNB'+Math.random().toString(36).slice(2,8).toUpperCase() };
  const arr = getAllBookings(); arr.unshift(booking);
  localStorage.setItem('bnb_bookings', JSON.stringify(arr.slice(0,300)));
  fsWrite('bookings', booking);
  addNotification({type:'booking',title:'Booking Submitted',body:`Your booking for ${data.listingTitle} (${nights} nights) has been submitted. Ref: ${booking.ref}`,listingId:data.listingId});
  return booking;
}

function getAllBookings() { return JSON.parse(localStorage.getItem('bnb_bookings')||'[]'); }
function getBookings(listingId) { const all=getAllBookings(); return listingId?all.filter(b=>b.listingId===listingId):all; }
function getUserBookings() { const u=uid(); return getAllBookings().filter(b=>b.uid===u); }

function updateBookingStatus(id, status) {
  const arr = getAllBookings();
  const idx = arr.findIndex(b=>b.id===id);
  if (idx>-1) { arr[idx].status=status; arr[idx].updatedAt=Date.now(); localStorage.setItem('bnb_bookings',JSON.stringify(arr)); fsWrite('bookings',arr[idx]); }
}

function checkAvailability(listingId, checkIn, checkOut) {
  const booked = getBookings(listingId).filter(b=>!['cancelled','checked_out'].includes(b.status));
  const inDate=new Date(checkIn).getTime(); const outDate=new Date(checkOut).getTime();
  return !booked.some(b=>{ const bIn=new Date(b.checkIn).getTime(); const bOut=new Date(b.checkOut).getTime(); return inDate<bOut && outDate>bIn; });
}

/* ── SAVED / WISHLIST ── */
function saveListing(id) {
  const key='bnb_saved_'+uid(); const arr=JSON.parse(localStorage.getItem(key)||'[]');
  if(arr.includes(id)){localStorage.setItem(key,JSON.stringify(arr.filter(x=>x!==id)));return false;}
  arr.unshift(id); localStorage.setItem(key,JSON.stringify(arr.slice(0,100))); return true;
}
function getSaved() { const ids=JSON.parse(localStorage.getItem('bnb_saved_'+uid())||'[]'); return ids.map(id=>getListingById(id)).filter(Boolean); }
function isSaved(id) { return JSON.parse(localStorage.getItem('bnb_saved_'+uid())||'[]').includes(id); }

/* ── HOSTS ── */
function getHosts(filter) {
  let list = [...HOSTS, ...fsRead('hosts')];
  if(filter?.q){const q=filter.q.toLowerCase();list=list.filter(h=>(h.name+h.location).toLowerCase().includes(q));}
  if(filter?.verified)list=list.filter(h=>h.verified);
  return list;
}
function getHostById(id){ return HOSTS.find(h=>h.id===id)||fsRead('hosts').find(h=>h.id===id); }

/* ── REVIEWS ── */
function addReview(targetId, data) {
  const key='bnb_reviews_'+targetId; const arr=JSON.parse(localStorage.getItem(key)||'[]');
  arr.unshift({id:'RV'+Date.now(),...data,targetId,ts:Date.now(),uid:uid()});
  localStorage.setItem(key,JSON.stringify(arr.slice(0,50)));
  fsWrite('reviews',{targetId,...data,ts:Date.now()});
}
function getReviews(targetId){ return JSON.parse(localStorage.getItem('bnb_reviews_'+targetId)||'[]'); }
function getAvgRating(targetId, base){ const arr=getReviews(targetId); if(!arr.length)return base||4.5; return (arr.reduce((s,r)=>s+r.rating,0)/arr.length).toFixed(1); }

/* ── NOTIFICATIONS ── */
function addNotification(data) {
  const arr=JSON.parse(localStorage.getItem('bnb_notifs')||'[]');
  arr.unshift({id:'BN'+Date.now(),...data,ts:Date.now(),read:false});
  localStorage.setItem('bnb_notifs',JSON.stringify(arr.slice(0,100)));
}
function getNotifications(){ return JSON.parse(localStorage.getItem('bnb_notifs')||'[]'); }
function markNotifRead(id){ const arr=getNotifications().map(n=>n.id===id?{...n,read:true}:n); localStorage.setItem('bnb_notifs',JSON.stringify(arr)); }
function getUnreadCount(){ return getNotifications().filter(n=>!n.read).length; }

/* ── UTILS ── */
function fmt(n){ return Number(n||0).toLocaleString('en-KE'); }
function fmtPrice(p,unit){ return 'KES '+fmt(p)+(unit&&unit!=='KES'?' '+unit.replace('KES/','/'):''); }
function timeSince(ts){ const d=Date.now()-ts; const m=Math.floor(d/60000); if(m<1)return'Just now'; if(m<60)return m+'m ago'; if(m<1440)return Math.floor(m/60)+'h ago'; return Math.floor(m/1440)+'d ago'; }
function starsHTML(r){ return[1,2,3,4,5].map(i=>`<span style="color:${i<=Math.round(r)?'#f59e0b':'rgba(255,255,255,0.15)'}">★</span>`).join(''); }
function amenityBadge(a){ const l=AMENITIES_MAP[a]; return l?`<span style="font-size:10px;padding:3px 7px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:5px;color:#ef4444;">${l}</span>`:''; }
function calcNightCost(price,checkIn,checkOut){ const n=Math.ceil((new Date(checkOut)-new Date(checkIn))/(1000*60*60*24)); return{nights:n,total:price*n}; }

async function syncUserDataFromFirestore(){
  const userId=uid(); if(!userId||userId==='guest') return;
  try {
    const db=_db(); if(!db) return;
    const bkSnap=await db.collection('bnbBookings').where('uid','==',userId).orderBy('createdAt','desc').limit(50).get().catch(()=>null);
    if(bkSnap&&!bkSnap.empty) localStorage.setItem('bnb_bookings',JSON.stringify(bkSnap.docs.map(d=>d.data())));
  } catch(e){ console.warn('[BnB] Sync from Firestore failed:',e); }
}

/* ── PUBLIC API ── */
window.SokoniBnB = {
  BNB_TYPES, BOOKING_STATUS, AMENITIES_MAP,
  LISTINGS, HOSTS,
  createListing, getListings, getListingById,
  createBooking, getAllBookings, getBookings, getUserBookings, updateBookingStatus, checkAvailability,
  saveListing, getSaved, isSaved,
  getHosts, getHostById,
  addReview, getReviews, getAvgRating,
  addNotification, getNotifications, markNotifRead, getUnreadCount,
  fmt, fmtPrice, timeSince, starsHTML, amenityBadge, calcNightCost,
  syncUserDataFromFirestore,
};
})();
