/* ============================================================
   SOKONI PROPERTY HUB — sokoni-property.js
   window.SokoniProperty IIFE module
   Marketplace · Listings · Viewings · Bookings · Finance · Legal
============================================================ */
;(function(){
'use strict';

/* ── Firestore helper ── */
function fsWrite(col, data) {
  try { if(window.SokoniDB?.saveApplication) return SokoniDB.saveApplication({...data, category:col}); } catch(e){}
  try {
    const key='prop_'+col; const arr=JSON.parse(localStorage.getItem(key)||'[]');
    const idx=arr.findIndex(x=>x.id===data.id);
    if(idx>-1) arr[idx]=data; else arr.unshift(data);
    localStorage.setItem(key, JSON.stringify(arr.slice(0,500)));
  } catch(e){}
}
function fsRead(col){ try{return JSON.parse(localStorage.getItem('prop_'+col)||'[]');}catch(e){return[];} }
function uid(){ try{return JSON.parse(localStorage.getItem('sokoniUser')||'{}').uid||'guest';}catch(e){return'guest';} }

/* ── PROPERTY TYPES ── */
const PROPERTY_TYPES = [
  {id:'all',        label:'All Properties',     icon:'🏘️', status:'any'},
  {id:'house_sale', label:'Houses for Sale',     icon:'🏡', status:'for_sale',  category:'house'},
  {id:'house_rent', label:'Houses for Rent',     icon:'🏠', status:'for_rent',  category:'house'},
  {id:'apartment',  label:'Apartments',          icon:'🏢', status:'any',       category:'apartment'},
  {id:'bedsitter',  label:'Bedsitters & Studios',icon:'🛏️', status:'any',       category:'bedsitter'},

  {id:'commercial', label:'Commercial Spaces',   icon:'🏪', status:'any',       category:'commercial'},
  {id:'land',       label:'Land & Plots',        icon:'🌍', status:'any',       category:'land'},
  {id:'warehouse',  label:'Warehouses',          icon:'🏭', status:'any',       category:'warehouse'},
  {id:'office',     label:'Office Spaces',       icon:'💼', status:'any',       category:'office'},
];

/* ── STATUS MAPS ── */
const PROPERTY_STATUS = {
  for_sale:   {label:'For Sale',    icon:'🏷️', color:'#22c55e'},
  for_rent:   {label:'For Rent',    icon:'🔑', color:'#00aaff'},

  sold:       {label:'Sold',        icon:'✅', color:'rgba(255,255,255,0.3)'},
  rented:     {label:'Rented',      icon:'🔒', color:'rgba(255,255,255,0.3)'},
};

const VIEWING_STATUS = {
  pending:   {label:'Pending Confirmation', color:'#f59e0b'},
  confirmed: {label:'Confirmed',            color:'#22c55e'},
  completed: {label:'Completed',            color:'#00aaff'},
  cancelled: {label:'Cancelled',            color:'#ef4444'},
};


const INQUIRY_STATUS = {
  new:               {label:'New',               color:'#f59e0b'},
  responded:         {label:'Responded',          color:'#00aaff'},
  viewing_scheduled: {label:'Viewing Scheduled',  color:'#a855f7'},
  closed:            {label:'Closed',             color:'rgba(255,255,255,0.3)'},
};

const AMENITIES_MAP = {
  parking:'🚗 Parking', security:'🛡️ Security', borehole:'💧 Borehole', generator:'⚡ Generator',
  wifi:'📶 WiFi', gym:'💪 Gym', pool:'🏊 Swimming Pool', garden:'🌿 Garden',
  cctv:'📷 CCTV', gate:'🚪 Electric Gate', elevator:'🛗 Elevator', servant_quarter:'🏠 SQ',
  ac:'❄️ Air Conditioning', solar:'☀️ Solar', backup_water:'💧 Water Backup', balcony:'🏙️ Balcony',
  study:'📚 Study Room', laundry:'👕 Laundry', furnished:'🛋️ Furnished', pets:'🐾 Pets Allowed',
};

/* ── AGENTS ── */
const AGENTS = [
  {id:'agt001',name:'Amani Properties',contact:'James Mwangi',type:'agency',location:'Westlands, Nairobi',phone:'0712 001 001',email:'james@amani.co.ke',verified:true,rating:4.9,reviews:73,listings:47,yearsExp:12,specialties:['residential','commercial'],bio:'Leading real estate agency in Nairobi with 12 years of experience. Specializing in high-end residential and prime commercial properties.',icon:'🏢'},
  {id:'agt002',name:'Coastal Homes Kenya',contact:'Fatuma Hassan',type:'agency',location:'Mombasa CBD',phone:'0723 002 002',email:'info@coastalhomes.co.ke',verified:true,rating:4.7,reviews:41,listings:23,yearsExp:8,specialties:['residential','airbnb'],bio:'Mombasa\'s trusted property agents. Beach houses, apartments and short-stay properties along the Kenyan coast.',icon:'🌴'},
  {id:'agt003',name:'Prime Real Estate',contact:'David Kamau',type:'agency',location:'Upper Hill, Nairobi',phone:'0734 003 003',email:'david@primerealestate.co.ke',verified:true,rating:4.8,reviews:112,listings:89,yearsExp:15,specialties:['commercial','office','land'],bio:'Kenya\'s premier commercial real estate firm. Office spaces, commercial properties and premium land across Kenya.',icon:'🏗️'},
  {id:'agt004',name:'Valley Properties',contact:'Susan Njeri',type:'individual',location:'Nakuru Town',phone:'0745 004 004',email:'susan@valleyprop.co.ke',verified:true,rating:4.5,reviews:29,listings:31,yearsExp:6,specialties:['residential','land'],bio:'Your trusted property agent in Rift Valley. Houses, plots and land in Nakuru, Naivasha, Eldoret and surrounding areas.',icon:'🏡'},
  {id:'agt005',name:'Landmark Realty',contact:'Peter Ochieng',type:'agency',location:'Kisumu CBD',phone:'0756 005 005',email:'info@landmarkrealty.co.ke',verified:true,rating:4.6,reviews:54,listings:56,yearsExp:10,specialties:['residential','commercial'],bio:'Kisumu and Lake Victoria region\'s leading property agency. Residential, commercial and lakefront properties.',icon:'🌊'},
  {id:'agt006',name:'Sun Lettings Kenya',contact:'Mary Wanjiku',type:'individual',location:'Karen, Nairobi',phone:'0767 006 006',email:'mary@sunlettings.co.ke',verified:false,rating:4.3,reviews:18,listings:18,yearsExp:4,specialties:['residential'],bio:'Boutique lettings agency specializing in Karen and Langata. High quality homes for discerning tenants and buyers.',icon:'☀️'},
];

/* ── PROPERTY LISTINGS ── */
const PROPERTIES = [
  /* ── HOUSES FOR SALE ── */
  {id:'p001',agentId:'agt001',agentName:'Amani Properties',category:'house',status:'for_sale',title:'Executive 4BR Family Home in Lavington',location:'Lavington, Nairobi',county:'nairobi',price:28500000,priceUnit:'KES',bedrooms:4,bathrooms:3,size:350,sizeUnit:'sqm',parking:2,furnished:false,amenities:['parking','security','borehole','generator','garden','cctv','gate'],description:'Stunning 4-bedroom all-ensuite family home nestled in the leafy suburb of Lavington. Features a spacious open-plan living area, modern kitchen with island, separate DSQ, large garden and swimming pool. Gated community with 24hr security.',features:['Open plan kitchen','Master en-suite with jacuzzi','Swimming pool','Landscaped garden','DSQ for staff','Double garage'],images:['🏡','🛋️','🍳','🌿'],yearBuilt:2019,icon:'🏡',featured:true,views:234,inquiries:18},
  {id:'p002',agentId:'agt004',agentName:'Valley Properties',category:'house',status:'for_sale',title:'3BR Bungalow for Sale in Nakuru Milimani',location:'Milimani, Nakuru',county:'nakuru',price:12800000,priceUnit:'KES',bedrooms:3,bathrooms:2,size:210,sizeUnit:'sqm',parking:2,furnished:false,amenities:['parking','garden','borehole','gate'],description:'Modern 3-bedroom bungalow in Nakuru\'s prestigious Milimani estate. Well-maintained with a beautiful garden and easy access to Nakuru town. Ideal for families relocating to Nakuru.',features:['Open plan living','Modern kitchen','Staff quarters','Fruit garden','Borehole','Backup tank'],images:['🏡','🌿'],yearBuilt:2016,icon:'🏡',featured:false,views:87,inquiries:6},
  {id:'p003',agentId:'agt001',agentName:'Amani Properties',category:'house',status:'for_sale',title:'5BR Mansion with Pool in Runda',location:'Runda Estate, Nairobi',county:'nairobi',price:75000000,priceUnit:'KES',bedrooms:5,bathrooms:5,size:620,sizeUnit:'sqm',parking:4,furnished:true,amenities:['parking','security','borehole','generator','pool','gym','garden','cctv','gate','elevator','ac'],description:'Ultra-luxury 5-bedroom mansion in the exclusive Runda Estate. Fully furnished with premium fittings. Features a private swimming pool, home gym, cinema room, wine cellar, and expansive landscaped grounds. Gated estate with controlled access.',features:['Cinema room','Wine cellar','Home gym','Private pool','Smart home system','Triple garage','Solar panels'],images:['🏰','🌊','💪'],yearBuilt:2021,icon:'🏰',featured:true,views:412,inquiries:32},
  {id:'p004',agentId:'agt006',agentName:'Sun Lettings Kenya',category:'house',status:'for_sale',title:'3BR Semi-Detached in Karen',location:'Karen, Nairobi',county:'nairobi',price:22000000,priceUnit:'KES',bedrooms:3,bathrooms:3,size:280,sizeUnit:'sqm',parking:2,furnished:false,amenities:['parking','garden','security','cctv'],description:'Elegant 3-bedroom semi-detached house in the prestigious Karen neighbourhood. Corner plot with large garden. Close to Karen Shopping Centre, international schools and hospitals.',features:['Corner plot','Large garden','Modern kitchen','Study room','Laundry room'],images:['🏡','🌿'],yearBuilt:2018,icon:'🏡',featured:false,views:143,inquiries:9},

  /* ── HOUSES FOR RENT ── */
  {id:'p005',agentId:'agt001',agentName:'Amani Properties',category:'house',status:'for_rent',title:'Spacious 4BR Home for Rent in Kileleshwa',location:'Kileleshwa, Nairobi',county:'nairobi',price:145000,priceUnit:'KES/month',bedrooms:4,bathrooms:3,size:320,sizeUnit:'sqm',parking:2,furnished:false,amenities:['parking','security','borehole','garden','cctv','gate'],description:'Well-maintained 4-bedroom home in the quiet and upmarket Kileleshwa neighbourhood. Available immediately. Ideal for families. Monthly rent is KES 145,000 exclusive of water and electricity.',features:['Garden','DSQ','Double parking','Borehole backup','24hr security'],images:['🏠','🌿'],icon:'🏠',featured:true,views:198,inquiries:22},
  {id:'p006',agentId:'agt006',agentName:'Sun Lettings Kenya',category:'house',status:'for_rent',title:'3BR Townhouse for Rent in Langata',location:'Langata, Nairobi',county:'nairobi',price:80000,priceUnit:'KES/month',bedrooms:3,bathrooms:2,size:180,sizeUnit:'sqm',parking:1,furnished:false,amenities:['parking','security','borehole','garden'],description:'Modern 3-bedroom townhouse in a secure estate in Langata. Two en-suite bedrooms, open plan living area, small garden. Walking distance to Galleria Mall.',features:['2 en-suite bedrooms','Garden','1 parking','Secure estate'],images:['🏠'],icon:'🏠',featured:false,views:76,inquiries:8},

  /* ── APARTMENTS ── */
  {id:'p007',agentId:'agt001',agentName:'Amani Properties',category:'apartment',status:'for_rent',title:'Modern 2BR Apartment in Westlands',location:'Westlands, Nairobi',county:'nairobi',price:75000,priceUnit:'KES/month',bedrooms:2,bathrooms:2,size:95,sizeUnit:'sqm',parking:1,furnished:false,amenities:['parking','security','elevator','cctv','backup_water'],description:'Contemporary 2-bedroom apartment in a secure Westlands block. Walking distance to Westgate Mall, restaurants and banks. All en-suite. 5th floor with city views.',features:['City views','All en-suite','Lift access','CCTV','Secure parking'],images:['🏢','🌆'],icon:'🏢',featured:true,views:167,inquiries:14},
  {id:'p008',agentId:'agt003',agentName:'Prime Real Estate',category:'apartment',status:'for_sale',title:'1BR Apartment Investment in Kilimani',location:'Kilimani, Nairobi',county:'nairobi',price:8500000,priceUnit:'KES',bedrooms:1,bathrooms:1,size:65,sizeUnit:'sqm',parking:1,furnished:false,amenities:['parking','security','elevator','pool','gym','cctv'],description:'Investor-friendly 1-bedroom apartment in the heart of Kilimani. High-rise development with communal pool and gym. Currently earning KES 45,000/month when rented. 12% annual ROI.',features:['Investment grade','Rooftop pool','Gym','12% ROI','Prime location'],images:['🏢','🏊'],icon:'🏢',featured:true,views:289,inquiries:41},
  {id:'p009',agentId:'agt005',agentName:'Landmark Realty',category:'apartment',status:'for_rent',title:'Lakefront 2BR Apartment in Kisumu',location:'Milimani, Kisumu',county:'kisumu',price:45000,priceUnit:'KES/month',bedrooms:2,bathrooms:2,size:88,sizeUnit:'sqm',parking:1,furnished:false,amenities:['parking','security','backup_water','balcony'],description:'Beautiful 2-bedroom apartment with stunning Lake Victoria views from the balcony. Located in Kisumu\'s Milimani estate. Quiet, secure and ideal for professionals.',features:['Lake views','Balcony','Secure estate','Parking'],images:['🏢','🌊'],icon:'🏢',featured:false,views:54,inquiries:5},
  {id:'p010',agentId:'agt004',agentName:'Valley Properties',category:'apartment',status:'for_sale',title:'3BR Apartment for Sale in Nakuru Town',location:'Section 58, Nakuru',county:'nakuru',price:9800000,priceUnit:'KES',bedrooms:3,bathrooms:2,size:130,sizeUnit:'sqm',parking:1,furnished:false,amenities:['parking','security','backup_water'],description:'Spacious 3-bedroom apartment in a prime Nakuru location. Perfect starter home or investment property. Bank financing accepted.',features:['3 bedrooms','2 bathrooms','Secure parking','Good investment'],images:['🏢'],icon:'🏢',featured:false,views:63,inquiries:7},

  /* ── BEDSITTERS & STUDIOS ── */
  {id:'p011',agentId:'agt001',agentName:'Amani Properties',category:'bedsitter',status:'for_rent',title:'Self-Contained Studio in South B',location:'South B, Nairobi',county:'nairobi',price:18000,priceUnit:'KES/month',bedrooms:0,bathrooms:1,size:28,sizeUnit:'sqm',parking:0,furnished:true,amenities:['security','furnished','wifi'],description:'Neat and cosy furnished studio apartment in South B. Self-contained with a kitchenette. WiFi included. Ideal for young professionals or students. Walking distance to Junction Mall.',features:['Furnished','WiFi included','Kitchenette','Self-contained','Security'],images:['🛏️'],icon:'🛏️',featured:false,views:445,inquiries:67},
  {id:'p012',agentId:'agt006',agentName:'Sun Lettings Kenya',category:'bedsitter',status:'for_rent',title:'Studio Apartment in Westlands',location:'Westlands, Nairobi',county:'nairobi',price:35000,priceUnit:'KES/month',bedrooms:0,bathrooms:1,size:38,sizeUnit:'sqm',parking:0,furnished:false,amenities:['security','elevator','backup_water','cctv'],description:'Modern studio apartment in a new block in Westlands. Open plan design with high-quality finishes. In the heart of Westlands close to all amenities.',features:['High finishes','Lift access','CCTV','Secure'],images:['🛏️'],icon:'🛏️',featured:false,views:112,inquiries:15},

  /* ── COMMERCIAL ── */
  {id:'p017',agentId:'agt003',agentName:'Prime Real Estate',category:'commercial',status:'for_rent',title:'Prime Shop Space on Ngong Road',location:'Ngong Road, Nairobi',county:'nairobi',price:180000,priceUnit:'KES/month',bedrooms:0,bathrooms:2,size:250,sizeUnit:'sqm',parking:4,furnished:false,amenities:['parking','security','generator','cctv'],description:'Prime ground floor commercial space on busy Ngong Road. 250 sqm open-plan floor with 4 parking bays. High visibility, high foot traffic. Previously used as a supermarket. Ideal for retail, bank or showroom.',features:['Ground floor','High visibility','4 parking bays','Generator backup','250 sqm'],images:['🏪'],icon:'🏪',featured:true,views:156,inquiries:19},
  {id:'p018',agentId:'agt003',agentName:'Prime Real Estate',category:'commercial',status:'for_rent',title:'Modern Shop — Westlands Arcade',location:'Westlands, Nairobi',county:'nairobi',price:65000,priceUnit:'KES/month',bedrooms:0,bathrooms:1,size:80,sizeUnit:'sqm',parking:2,furnished:false,amenities:['parking','security','cctv'],description:'Smart 80 sqm retail space in the popular Westlands Arcade. High foot traffic location with 2 allocated parking. Ideal for boutique, restaurant or specialty shop.',features:['80 sqm','High foot traffic','2 parking','Security'],images:['🏪'],icon:'🏪',featured:false,views:89,inquiries:11},

  /* ── LAND & PLOTS ── */
  {id:'p019',agentId:'agt003',agentName:'Prime Real Estate',category:'land',status:'for_sale',title:'5 Acres Agricultural Land — Thika Road',location:'Ruiru, Kiambu',county:'kiambu',price:14500000,priceUnit:'KES',bedrooms:0,bathrooms:0,size:5,sizeUnit:'acres',parking:0,furnished:false,amenities:['borehole'],description:'Fertile 5-acre agricultural land along Thika Road. Title deed available. Borehole on site. Accessible tarmac road. Ideal for farming, greenhouse horticulture or subdivision. Fast-growing area with high investment returns.',features:['Title deed','Borehole','Tarmac access','5 acres','Fertile soil'],images:['🌍'],icon:'🌍',featured:true,views:210,inquiries:28},
  {id:'p020',agentId:'agt004',agentName:'Valley Properties',category:'land',status:'for_sale',title:'1/4 Acre Residential Plot in Ruiru',location:'Ruiru, Kiambu',county:'kiambu',price:2800000,priceUnit:'KES',bedrooms:0,bathrooms:0,size:0.25,sizeUnit:'acres',parking:0,furnished:false,amenities:[],description:'Ready-to-build 1/4 acre residential plot in a gated community in Ruiru. All utilities available — water, electricity, tarmac access. Title deed ready for immediate transfer.',features:['Title deed','Electricity','Water','Tarmac road','Gated community'],images:['🌍'],icon:'🌍',featured:false,views:143,inquiries:22},
  {id:'p021',agentId:'agt003',agentName:'Prime Real Estate',category:'land',status:'for_sale',title:'Commercial Plot on Mombasa Road',location:'Mlolongo, Machakos',county:'machakos',price:18000000,priceUnit:'KES',bedrooms:0,bathrooms:0,size:1,sizeUnit:'acres',parking:0,furnished:false,amenities:[],description:'Strategic 1-acre commercial plot on Mombasa Road near JKIA. Ideal for logistics, fuel station, warehouse or hospitality. High traffic road with excellent visibility.',features:['1 acre','Mombasa Road','High visibility','Title deed','Commercial zoning'],images:['🌍'],icon:'🌍',featured:false,views:178,inquiries:31},

  /* ── WAREHOUSES ── */
  {id:'p022',agentId:'agt003',agentName:'Prime Real Estate',category:'warehouse',status:'for_rent',title:'Industrial Warehouse — Athi River',location:'Athi River, Machakos',county:'machakos',price:380000,priceUnit:'KES/month',bedrooms:0,bathrooms:2,size:1200,sizeUnit:'sqm',parking:10,furnished:false,amenities:['parking','security','generator','borehole'],description:'Large 1,200 sqm warehouse in Athi River EPZ area. High clearance (8m). 10-tonne capacity floor. Generator backup. Borehole for industrial use. Tarmac access. 10+ truck parking.',features:['1200 sqm','8m clearance','Generator','10+ parking','Borehole','Security'],images:['🏭'],icon:'🏭',featured:false,views:67,inquiries:9},

  /* ── OFFICES ── */
  {id:'p023',agentId:'agt003',agentName:'Prime Real Estate',category:'office',status:'for_rent',title:'Prime Office Space — Upper Hill',location:'Upper Hill, Nairobi',county:'nairobi',price:250000,priceUnit:'KES/month',bedrooms:0,bathrooms:4,size:450,sizeUnit:'sqm',parking:8,furnished:false,amenities:['parking','security','elevator','generator','ac','cctv','backup_water'],description:'Class-A office space in Upper Hill CBD. 450 sqm open-plan floor plate. 8 dedicated parking bays. High-speed fibre, generator, 24hr security. Ideal for corporates, NGOs and embassies.',features:['450 sqm','Class-A','8 parking','Fibre internet','Generator','24hr security'],images:['💼'],icon:'💼',featured:true,views:132,inquiries:17},
  {id:'p024',agentId:'agt001',agentName:'Amani Properties',category:'office',status:'for_rent',title:'Co-working / SME Office — Westlands',location:'Westlands, Nairobi',county:'nairobi',price:45000,priceUnit:'KES/month',bedrooms:0,bathrooms:2,size:80,sizeUnit:'sqm',parking:2,furnished:true,amenities:['parking','security','elevator','wifi','ac','furnished'],description:'Fully furnished SME office in Westlands. 80 sqm with 2 meeting rooms, reception area and high-speed WiFi. Move-in ready. 2 parking bays included.',features:['Furnished','WiFi included','2 meeting rooms','Move-in ready','2 parking'],images:['💼'],icon:'💼',featured:false,views:198,inquiries:26},
];

/* ── PROPERTY SERVICES ── */
const PROPERTY_SERVICES = [
  {id:'svc001',name:'KE Survey & Valuation',type:'surveyor',rating:4.8,location:'Nairobi',phone:'0712 100 001',desc:'Licensed surveyors and valuers. Title searches, property valuations, boundary surveys. Nationwide coverage.',icon:'📐'},
  {id:'svc002',name:'MoveIt Kenya',type:'mover',rating:4.6,location:'Nairobi & Mombasa',phone:'0723 100 002',desc:'Professional home and office movers. Packing, storage, local and upcountry delivery.',icon:'🚚'},
  {id:'svc003',name:'CleanPro Services',type:'cleaning',rating:4.7,location:'Nairobi',phone:'0734 100 003',desc:'Post-construction cleaning, end-of-tenancy cleaning, regular home and office cleaning.',icon:'🧹'},
  {id:'svc004',name:'PropManage Kenya',type:'manager',rating:4.5,location:'Nairobi',phone:'0745 100 004',desc:'Full property management: tenant screening, rent collection, maintenance, reporting.',icon:'🏠'},
  {id:'svc005',name:'Design & Build Ltd',type:'contractor',rating:4.9,location:'Nairobi',phone:'0756 100 005',desc:'Licensed building contractor. Construction, renovation, extension and finishing works.',icon:'🏗️'},
  {id:'svc006',name:'Archspace Kenya',type:'architect',rating:4.8,location:'Nairobi',phone:'0767 100 006',desc:'Registered architects. House plans, approvals, interior design and project management.',icon:'📋'},
  {id:'svc007',name:'RenovatePro',type:'renovation',rating:4.4,location:'Nairobi & Mombasa',phone:'0778 100 007',desc:'Kitchen, bathroom, flooring and interior renovation specialists.',icon:'🔨'},
  {id:'svc008',name:'KE Mortgage Hub',type:'finance',rating:4.7,location:'Online',phone:'0789 100 008',desc:'Mortgage comparison and application platform. KCB, Stanbic, HF Group, NCBA and more.',icon:'💰'},
];

/* ══ LISTING FUNCTIONS ══ */
function createListing(data) {
  const id = 'PRP' + Date.now();
  const listing = { id, ...data, status: data.status||'for_sale', agentId: data.agentId||uid(), views:0, inquiries:0, createdAt: Date.now() };
  const arr = fsRead('listings'); arr.unshift(listing);
  localStorage.setItem('prop_listings', JSON.stringify(arr.slice(0,200)));
  fsWrite('listings', listing);
  return listing;
}

function getListings(filter) {
  const extra = fsRead('listings');
  let list = [...PROPERTIES, ...extra];
  if (!filter) return list;
  if (filter.status && filter.status!=='any')     list = list.filter(p=>p.status===filter.status);
  if (filter.category && filter.category!=='all') list = list.filter(p=>p.category===filter.category);
  if (filter.county)   list = list.filter(p=>p.county?.toLowerCase().includes(filter.county.toLowerCase()));
  if (filter.minPrice) list = list.filter(p=>p.price>=filter.minPrice);
  if (filter.maxPrice) list = list.filter(p=>p.price<=filter.maxPrice);
  if (filter.bedrooms) list = list.filter(p=>p.bedrooms>=parseInt(filter.bedrooms));
  if (filter.furnished!==undefined&&filter.furnished!==null) list=list.filter(p=>p.furnished===filter.furnished);
  if (filter.q) {
    const q=filter.q.toLowerCase();
    list=list.filter(p=>(p.title+p.location+p.description+p.county+(p.amenities||[]).join(' ')).toLowerCase().includes(q));
  }
  if (filter.featured) list = list.filter(p=>p.featured);
  return list;
}

function getListingById(id) {
  return [...PROPERTIES, ...fsRead('listings')].find(p=>p.id===id);
}

function updateListing(id, updates) {
  const arr = fsRead('listings');
  const sIdx = arr.findIndex(p=>p.id===id);
  if (sIdx>-1) { arr[sIdx]={...arr[sIdx],...updates}; localStorage.setItem('prop_listings',JSON.stringify(arr)); fsWrite('listings',arr[sIdx]); }
}

/* ══ VIEWING FUNCTIONS ══ */
function requestViewing(data) {
  const id = 'VW' + Date.now();
  const viewing = { id, ...data, status:'pending', createdAt:Date.now(), uid:uid() };
  const arr = getViewings(); arr.unshift(viewing);
  localStorage.setItem('prop_viewings', JSON.stringify(arr.slice(0,200)));
  fsWrite('viewings', viewing);
  addNotification({type:'viewing',title:'Viewing Request Sent',body:`Your viewing request for "${data.propertyTitle}" has been sent.`,propId:data.propertyId});
  return viewing;
}

function getViewings(propId) {
  const all = JSON.parse(localStorage.getItem('prop_viewings')||'[]');
  return propId ? all.filter(v=>v.propertyId===propId) : all;
}

function updateViewingStatus(id, status) {
  const arr = getViewings();
  const idx = arr.findIndex(v=>v.id===id);
  if (idx>-1) { arr[idx].status=status; arr[idx].updatedAt=Date.now(); }
  localStorage.setItem('prop_viewings', JSON.stringify(arr));
  if (idx>-1) fsWrite('viewings', arr[idx]);
}

/* ══ INQUIRY FUNCTIONS ══ */
function sendInquiry(data) {
  const id = 'INQ' + Date.now();
  const inq = { id, ...data, status:'new', createdAt:Date.now(), uid:uid() };
  const arr = getInquiries(); arr.unshift(inq);
  localStorage.setItem('prop_inquiries', JSON.stringify(arr.slice(0,300)));
  fsWrite('inquiries', inq);
  addNotification({type:'inquiry',title:'Inquiry Sent',body:`Your inquiry for "${data.propertyTitle}" has been sent to the agent.`,propId:data.propertyId});
  return inq;
}

function getInquiries(propId) {
  const all = JSON.parse(localStorage.getItem('prop_inquiries')||'[]');
  return propId ? all.filter(i=>i.propertyId===propId) : all;
}

function updateInquiryStatus(id, status) {
  const arr = getInquiries();
  const idx = arr.findIndex(i=>i.id===id);
  if (idx>-1) { arr[idx].status=status; arr[idx].updatedAt=Date.now(); }
  localStorage.setItem('prop_inquiries', JSON.stringify(arr));
}

/* ══ SAVED PROPERTIES ══ */
function saveProperty(propId) {
  const key = 'prop_saved_' + uid();
  const arr = JSON.parse(localStorage.getItem(key)||'[]');
  if (arr.includes(propId)) { localStorage.setItem(key,JSON.stringify(arr.filter(id=>id!==propId))); return false; }
  arr.unshift(propId);
  localStorage.setItem(key, JSON.stringify(arr.slice(0,100)));
  return true;
}

function getSavedProperties() {
  const ids = JSON.parse(localStorage.getItem('prop_saved_'+uid())||'[]');
  return ids.map(id=>getListingById(id)).filter(Boolean);
}

function isSaved(propId) {
  return JSON.parse(localStorage.getItem('prop_saved_'+uid())||'[]').includes(propId);
}

/* ══ AGENTS ══ */
function getAgents(filter) {
  let list = [...AGENTS, ...fsRead('agents')];
  if (filter?.q) { const q=filter.q.toLowerCase(); list=list.filter(a=>(a.name+a.contact+a.location+(a.specialties||[]).join(' ')).toLowerCase().includes(q)); }
  if (filter?.verified) list=list.filter(a=>a.verified);
  return list;
}

function getAgentById(id) { return AGENTS.find(a=>a.id===id)||fsRead('agents').find(a=>a.id===id); }

/* ══ REVIEWS ══ */
function addReview(targetId, targetType, data) {
  const key='prop_reviews_'+targetId;
  const arr=JSON.parse(localStorage.getItem(key)||'[]');
  arr.unshift({id:'RV'+Date.now(),...data,targetId,targetType,ts:Date.now(),uid:uid()});
  localStorage.setItem(key,JSON.stringify(arr.slice(0,50)));
  fsWrite('reviews',{targetId,targetType,...data,ts:Date.now()});
}

function getReviews(targetId) { return JSON.parse(localStorage.getItem('prop_reviews_'+targetId)||'[]'); }

function getAvgRating(targetId, baseRating) {
  const arr=getReviews(targetId);
  if(!arr.length) return baseRating||4.5;
  return (arr.reduce((s,r)=>s+r.rating,0)/arr.length).toFixed(1);
}

/* ══ FINANCE REQUESTS ══ */
function submitFinanceRequest(data) {
  const id='FIN'+Date.now();
  const req={id,...data,type:data.type||'mortgage',status:'pending',createdAt:Date.now(),uid:uid()};
  const arr=JSON.parse(localStorage.getItem('prop_finance')||'[]');
  arr.unshift(req); localStorage.setItem('prop_finance',JSON.stringify(arr.slice(0,100)));
  fsWrite('finance_requests',req);
  addNotification({type:'finance',title:'Finance Request Submitted',body:`Your ${data.type||'mortgage'} request has been received. A specialist will contact you within 24 hours.`});
  return req;
}

function getFinanceRequests() { return JSON.parse(localStorage.getItem('prop_finance')||'[]'); }

/* ══ LEGAL REQUESTS ══ */
function submitLegalRequest(data) {
  const id='LGL'+Date.now();
  const req={id,...data,status:'pending',createdAt:Date.now(),uid:uid()};
  const arr=JSON.parse(localStorage.getItem('prop_legal')||'[]');
  arr.unshift(req); localStorage.setItem('prop_legal',JSON.stringify(arr.slice(0,100)));
  fsWrite('legal_requests',req);
  addNotification({type:'legal',title:'Legal Request Submitted',body:`Your ${data.type||'legal'} request has been received.`});
  return req;
}

/* ══ NOTIFICATIONS ══ */
function addNotification(data) {
  const arr=JSON.parse(localStorage.getItem('prop_notifs')||'[]');
  arr.unshift({id:'PN'+Date.now(),...data,ts:Date.now(),read:false});
  localStorage.setItem('prop_notifs',JSON.stringify(arr.slice(0,100)));
}

function getNotifications() { return JSON.parse(localStorage.getItem('prop_notifs')||'[]'); }
function markNotifRead(id) {
  const arr=getNotifications().map(n=>n.id===id?{...n,read:true}:n);
  localStorage.setItem('prop_notifs',JSON.stringify(arr));
}
function getUnreadCount() { return getNotifications().filter(n=>!n.read).length; }

/* ══ ANALYTICS ══ */
function getUserStats() {
  return { saved:getSavedProperties().length, viewings:getViewings().length, inquiries:getInquiries().length };
}

function getAgentStats(agentId) {
  const myListings = getListings({agentId}).length + PROPERTIES.filter(p=>p.agentId===agentId).length;
  const myInquiries = getInquiries().filter(i=>i.agentId===agentId);
  const myViewings = getViewings().filter(v=>v.agentId===agentId);
  return { listings: myListings, inquiries: myInquiries.length, viewings: myViewings.length, confirmed: myViewings.filter(v=>v.status==='confirmed').length };
}

/* ══ MORTGAGE CALCULATOR ══ */
function calcMortgage(price, deposit, years, rate) {
  const principal=price-(deposit||0); const r=(rate||12)/100/12; const n=years*12;
  if(!principal||!n) return null;
  const monthly=r>0?principal*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1):principal/n;
  return { principal, monthly:Math.round(monthly), total:Math.round(monthly*n), interest:Math.round(monthly*n-principal) };
}

/* ── Utils ── */
function fmt(n) { return Number(n||0).toLocaleString('en-KE'); }
function fmtPrice(p,unit) { return 'KES '+fmt(p)+(unit&&unit!=='KES'?' '+unit.replace('KES/','/'):''); }
function timeSince(ts) { const d=Date.now()-ts; const m=Math.floor(d/60000); if(m<1)return'Just now'; if(m<60)return m+'m ago'; if(m<1440)return Math.floor(m/60)+'h ago'; return Math.floor(m/1440)+'d ago'; }
function starsHTML(rating) { return[1,2,3,4,5].map(i=>`<span style="color:${i<=Math.round(rating)?'#f59e0b':'rgba(255,255,255,0.15)'}">★</span>`).join(''); }
function amenityBadge(a) { const l=AMENITIES_MAP[a]; return l?`<span style="font-size:10px;padding:3px 7px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.18);border-radius:5px;color:#10b981;">${l}</span>`:''; }
function specBadge(icon,val,label) { return `<div style="text-align:center;"><div style="font-size:18px;">${icon}</div><div style="font-size:13px;font-weight:800;color:white;">${val}</div><div style="font-size:10px;color:rgba(255,255,255,0.35);">${label}</div></div>`; }

/* ── Public API ── */
window.SokoniProperty = {
  PROPERTY_TYPES, PROPERTY_STATUS, VIEWING_STATUS, INQUIRY_STATUS,
  PROPERTIES, AGENTS, PROPERTY_SERVICES, AMENITIES_MAP,
  createListing, getListings, getListingById, updateListing,
  requestViewing, getViewings, updateViewingStatus,
  sendInquiry, getInquiries, updateInquiryStatus,
  saveProperty, getSavedProperties, isSaved,
  getAgents, getAgentById,
  addReview, getReviews, getAvgRating,
  submitFinanceRequest, getFinanceRequests,
  submitLegalRequest,
  addNotification, getNotifications, markNotifRead, getUnreadCount,
  getUserStats, getAgentStats,
  calcMortgage,
  fmt, fmtPrice, timeSince, starsHTML, amenityBadge, specBadge,
};
})();
