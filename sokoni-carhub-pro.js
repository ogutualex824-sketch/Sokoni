/* ================================================================
   SOKONI CAR HUB PRO — Complete Automotive Ecosystem
   Mechanics · Spare Parts · Roadside Assistance · Financing
   Vehicle Inspection · Car Transport · Buyer Dashboard
   AI Price Estimation · Trust & Verification · Dealer Analytics

   Loaded by: car-hub.html
================================================================ */

window.CarHubPro = (function(){
  'use strict';

  /* ── Utilities ── */
  const _esc = s => String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function toast(msg, type) {
    let el = document.getElementById('carHubToast');
    if(!el){
      el = document.createElement('div'); el.id='carHubToast';
      el.className='ch-toast'; document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.borderColor = type==='error'?'rgba(255,77,77,0.4)':'rgba(113,255,0,0.3)';
    el.style.color = type==='error'?'#ff6b6b':'#71ff00';
    el.classList.add('show'); clearTimeout(el._t);
    el._t = setTimeout(()=>el.classList.remove('show'), 3500);
  }

  function kes(n){ return 'KES ' + Number(n||0).toLocaleString(); }

  async function fsWrite(collection, data) {
    try {
      if(window.SokoniDB && typeof window.SokoniDB.saveApplication === 'function'){
        return await window.SokoniDB.saveApplication({ ...data, category: collection });
      }
    } catch(e){ console.warn('[CarHubPro] Firestore:', e.message); }
    try {
      const key='chpro_'+collection;
      const arr=JSON.parse(localStorage.getItem(key)||'[]');
      arr.unshift(data);
      localStorage.setItem(key, JSON.stringify(arr.slice(0,200)));
    } catch(e){}
    return data.id||('REQ-'+Date.now());
  }

  function rateLimit(key, max, windowMs){
    if(window.SokoniSecurity && typeof window.SokoniSecurity.persistentRateLimit==='function')
      return window.SokoniSecurity.persistentRateLimit(key, max, windowMs);
    return true;
  }

  function saveBuyerActivity(key, item){
    try{
      const arr=JSON.parse(localStorage.getItem('chpro_buyer_'+key)||'[]');
      arr.unshift(item);
      localStorage.setItem('chpro_buyer_'+key, JSON.stringify(arr.slice(0,50)));
    }catch(e){}
  }

  function getBuyerActivity(key){
    try{ return JSON.parse(localStorage.getItem('chpro_buyer_'+key)||'[]'); }catch(e){ return []; }
  }

  /* ── City coordinates ── */
  const CITIES = {
    nairobi:{lat:-1.286,lng:36.817,label:'Nairobi'},
    mombasa:{lat:-4.042,lng:39.666,label:'Mombasa'},
    kisumu:{lat:-0.102,lng:34.761,label:'Kisumu'},
    nakuru:{lat:-0.303,lng:36.080,label:'Nakuru'},
    eldoret:{lat:0.521,lng:35.270,label:'Eldoret'},
    thika:{lat:-1.033,lng:37.069,label:'Thika'},
    nyeri:{lat:-0.417,lng:36.950,label:'Nyeri'},
    meru:{lat:0.047,lng:37.650,label:'Meru'},
    kisii:{lat:-0.681,lng:34.766,label:'Kisii'},
    malindi:{lat:-3.218,lng:40.117,label:'Malindi'},
  };

  /* ════════════════════════════════════════════════════
     DEMO DATA
  ════════════════════════════════════════════════════ */

  const DEMO_MECHANICS = [
    { id:'m1', name:'Kamau Auto Center', owner:'John Kamau', phone:'0712345678',
      specialties:['Engine Overhaul','Transmission','Brakes','Suspension'],
      city:'nairobi', location:'Westlands, Nairobi', rating:4.9, reviews:214,
      verified:true, emergency:true, openNow:true, priceFrom:500,
      image:'https://images.unsplash.com/photo-1487754180451-c456f719a1fc?w=400&q=70',
      bio:'20+ years experience. Toyota and Subaru specialist. Free diagnostics with every service.',
      responseTime:'15 min' },
    { id:'m2', name:'Mombasa Road Garage', owner:'Ali Hassan', phone:'0722111333',
      specialties:['AC Service','Electrical','Engine Diagnostics','Toyota Specialist'],
      city:'nairobi', location:'South B, Nairobi', rating:4.7, reviews:189,
      verified:true, emergency:false, openNow:true, priceFrom:800,
      image:'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=400&q=70',
      bio:'Specialist in Japanese vehicles. State-of-the-art diagnostic equipment.',
      responseTime:'30 min' },
    { id:'m3', name:'Kilimani Quick Fix', owner:'Grace Wairimu', phone:'0733444555',
      specialties:['Oil Change','Tyre Rotation','Battery','Brakes','AC Service'],
      city:'nairobi', location:'Kilimani, Nairobi', rating:4.6, reviews:156,
      verified:true, emergency:true, openNow:false, priceFrom:300,
      image:'https://images.unsplash.com/photo-1504222490345-c075b7011089?w=400&q=70',
      bio:'Quick turnaround service. Walk-ins welcome for minor repairs.',
      responseTime:'20 min' },
    { id:'m4', name:'Mombasa Auto Tech', owner:'Farouk Suleiman', phone:'0744555666',
      specialties:['4WD Specialist','Differential Service','Suspension','Engine'],
      city:'mombasa', location:'Nyali, Mombasa', rating:4.8, reviews:98,
      verified:true, emergency:true, openNow:true, priceFrom:600,
      image:'https://images.unsplash.com/photo-1487754180451-c456f719a1fc?w=400&q=70',
      bio:"Mombasa's top 4WD specialist. 15 years experience in off-road vehicles.",
      responseTime:'25 min' },
    { id:'m5', name:'Kisumu Motors', owner:'Omondi Otieno', phone:'0755666777',
      specialties:['Body Work','Panel Beating','Spray Painting','Dent Removal'],
      city:'kisumu', location:'Milimani, Kisumu', rating:4.5, reviews:67,
      verified:false, emergency:false, openNow:true, priceFrom:1000,
      image:'https://images.unsplash.com/photo-1504222490345-c075b7011089?w=400&q=70',
      bio:'Expert body work and paint shop. Insurance-approved repairer.',
      responseTime:'Same day' },
    { id:'m6', name:'Nakuru Fast Lane', owner:'Peter Chebet', phone:'0766777888',
      specialties:['Wheel Alignment','Suspension','Balancing','Steering'],
      city:'nakuru', location:'Town, Nakuru', rating:4.4, reviews:44,
      verified:true, emergency:false, openNow:true, priceFrom:400,
      image:'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=400&q=70',
      bio:'Specialist in suspension and wheel geometry. Computerized 3D alignment.',
      responseTime:'1 hour' },
    { id:'m7', name:'Eldoret Auto Hub', owner:'Koech Kiplagat', phone:'0777888999',
      specialties:['Engine Overhaul','Fuel Injection','Diesel Specialists'],
      city:'eldoret', location:'Kapsaret, Eldoret', rating:4.6, reviews:82,
      verified:true, emergency:true, openNow:true, priceFrom:700,
      image:'https://images.unsplash.com/photo-1504222490345-c075b7011089?w=400&q=70',
      bio:'Top diesel engine specialists in the Rift Valley. Tractors and trucks welcome.',
      responseTime:'45 min' },
    { id:'m8', name:'Thika Road Mechanics', owner:'James Mwangi', phone:'0788999001',
      specialties:['Electrical','Diagnostics','Alarm Systems','Sound Systems'],
      city:'nairobi', location:'Kasarani, Nairobi', rating:4.3, reviews:108,
      verified:false, emergency:false, openNow:true, priceFrom:350,
      image:'https://images.unsplash.com/photo-1487754180451-c456f719a1fc?w=400&q=70',
      bio:'Auto electricians with 12 years experience. Car alarm and tracker installation.',
      responseTime:'30 min' },
    /* Mobile Mechanics */
    { id:'m9', name:'Patrick Mobile Mechanic', owner:'Patrick Muthoni', phone:'0723002002',
      specialties:['Mobile Mechanic','Roadside Repair','Battery Jump-Start','Tyre Change','Oil Top-Up','AC Regas'],
      city:'nairobi', location:'Westlands / CBD, Nairobi', rating:4.8, reviews:287,
      verified:true, emergency:true, openNow:true, priceFrom:1000,
      image:'https://images.unsplash.com/photo-1504222490345-c075b7011089?w=400&q=70',
      bio:'Come to you anywhere in Nairobi within 30 mins. 24/7 emergency callout. No callout fee within 15 km.',
      responseTime:'20-30 min' },
    { id:'m10', name:'Machakos Roadside Help', owner:'Joseph Mutua', phone:'0722011011',
      specialties:['Mobile Mechanic','Puncture Repair','Battery Boost','Emergency Fuel Delivery','Tow Hookup'],
      city:'machakos', location:'Machakos Town / Mombasa Hwy', rating:4.5, reviews:134,
      verified:false, emergency:true, openNow:true, priceFrom:800,
      image:'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=400&q=70',
      bio:'24/7 roadside assistance in Machakos and along Mombasa highway. 30-minute response time.',
      responseTime:'30 min' },
    /* Tyre & Wheel Specialists */
    { id:'m11', name:'Precision Wheel & Tyre', owner:'David Ngugi', phone:'0745004004',
      specialties:['Tyre Fitting','Tyre Rotation','Wheel Balancing','Wheel Alignment','Nitrogen Inflation','Puncture Repair'],
      city:'nairobi', location:'Mombasa Road, Nairobi', rating:4.7, reviews:876,
      verified:true, emergency:false, openNow:true, priceFrom:800,
      image:'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=400&q=70',
      bio:'All tyre brands including Bridgestone, Pirelli, Michelin. Digital 3D wheel alignment. Truck tyres available.',
      responseTime:'Same day' },
    { id:'m12', name:'Nakuru Fast Tyres', owner:'Peter Chebet', phone:'0766777888',
      specialties:['Tyre Fitting','Tyre Rotation','Wheel Alignment','Balancing','Steering Check'],
      city:'nakuru', location:'Town Centre, Nakuru', rating:4.4, reviews:44,
      verified:true, emergency:false, openNow:true, priceFrom:400,
      image:'https://images.unsplash.com/photo-1489824904134-891ab64532f1?w=400&q=70',
      bio:'Specialist in wheel geometry and computerized 3D alignment. All brands in stock.',
      responseTime:'1 hour' },
    /* Car Wash & Detailing */
    { id:'m13', name:'Gleam Car Wash & Detail', owner:'Caroline Auma', phone:'0711222333',
      specialties:['Car Wash','Full Detailing','Interior Cleaning','Wax & Polish','Engine Wash','Steam Cleaning'],
      city:'nairobi', location:'Hurlingham, Nairobi', rating:4.8, reviews:332,
      verified:true, emergency:false, openNow:true, priceFrom:500,
      image:'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=70',
      bio:'Professional car wash and full detailing. Ceramic coating available. Pickup & drop-off service in Nairobi.',
      responseTime:'1-2 hours' },
    { id:'m14', name:'Mombasa Car Wash Centre', owner:'Said Omar', phone:'0722333444',
      specialties:['Car Wash','Interior Cleaning','Upholstery Cleaning','Wax & Polish','Odour Treatment'],
      city:'mombasa', location:'Nyali, Mombasa', rating:4.6, reviews:198,
      verified:true, emergency:false, openNow:true, priceFrom:400,
      image:'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=70',
      bio:'Premium car wash and interior detailing in Mombasa. Specialising in leather conditioning and odour removal.',
      responseTime:'2 hours' },
    /* Diagnostics Specialists */
    { id:'m15', name:'Thika Road Auto Centre', owner:'Dr. Stephen Karanja', phone:'0700009009',
      specialties:['Full Diagnostics','Engine Management Diagnostics','ABS Diagnostics','Airbag Diagnostics','Transmission ECU','DPF Cleaning'],
      city:'nairobi', location:'Roasters, Thika Rd, Nairobi', rating:4.9, reviews:167,
      verified:true, emergency:false, openNow:true, priceFrom:2000,
      image:'https://images.unsplash.com/photo-1487754180451-c456f719a1fc?w=400&q=70',
      bio:'Advanced diagnostics for all makes including BMW, Mercedes, Audi, VW. ADAS calibration available.',
      responseTime:'Same day' },
    { id:'m16', name:'Coast Auto Electricals & Diagnostics', owner:'Farouk Hassan', phone:'0734003003',
      specialties:['Engine Diagnostics','ECU Repair & Diagnostics','Wiring Diagnostics','Alternator Test','Central Locking','Alarm Systems'],
      city:'mombasa', location:'Changamwe, Mombasa', rating:4.8, reviews:198,
      verified:true, emergency:true, openNow:true, priceFrom:1200,
      image:'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=400&q=70',
      bio:"Mombasa's top auto electrician. All makes. ECU reprogramming, anti-theft systems, full electrical diagnostics.",
      responseTime:'Same day' },
  ];

  const DEMO_PARTS = [
    { id:'p1', name:'Toyota Land Cruiser 200 Front Bumper', make:'Toyota', model:'Land Cruiser 200',
      yearRange:'2016-2021', category:'Body Parts', type:'OEM', condition:'New', price:65000,
      seller:'Nairobi Autoparts', sellerPhone:'0712111222', sellerVerified:true,
      city:'nairobi', location:'Industrial Area, Nairobi',
      image:'https://images.unsplash.com/photo-1489824904134-891ab64532f1?w=400&q=70',
      inStock:true, description:'Genuine Toyota OEM front bumper. All brackets and sensor ports included. Delivery available.' },
    { id:'p2', name:'Subaru Forester 2.5L Engine Assembly', make:'Subaru', model:'Forester',
      yearRange:'2018-2022', category:'Engine', type:'OEM', condition:'Used', price:180000,
      seller:'Subaru Spares Kenya', sellerPhone:'0722222333', sellerVerified:true,
      city:'nairobi', location:'Mombasa Rd, Nairobi',
      image:'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=400&q=70',
      inStock:true, description:'Low-mileage 55,000km FB25 engine. Tested and running. 3-month limited warranty.' },
    { id:'p3', name:'Toyota Hilux Rear Shock Absorbers (Pair)', make:'Toyota', model:'Hilux',
      yearRange:'2016-2023', category:'Suspension', type:'Aftermarket', condition:'New', price:22000,
      seller:'Autozone Kenya', sellerPhone:'0733333444', sellerVerified:false,
      city:'nairobi', location:'Gikomba, Nairobi',
      image:'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=400&q=70',
      inStock:true, description:'Heavy-duty rear shocks for rough terrain. Enhanced off-road performance. Set of 2.' },
    { id:'p4', name:'Mercedes C200 Alternator (Rebuilt)', make:'Mercedes-Benz', model:'C200',
      yearRange:'2014-2020', category:'Electrical', type:'OEM', condition:'Refurbished', price:35000,
      seller:'German Parts Kenya', sellerPhone:'0744444555', sellerVerified:true,
      city:'nairobi', location:'Westlands, Nairobi',
      image:'https://images.unsplash.com/photo-1474978528675-4a50a4508dc7?w=400&q=70',
      inStock:true, description:'Professionally rebuilt to OEM specs. Tested at 13.5V-14.7V output. 6-month warranty.' },
    { id:'p5', name:'BMW X5 Brembo Brake Kit (Front+Rear)', make:'BMW', model:'X5',
      yearRange:'2014-2022', category:'Brakes', type:'Aftermarket', condition:'New', price:28000,
      seller:'BM Parts Africa', sellerPhone:'0755555666', sellerVerified:true,
      city:'nairobi', location:'Karen, Nairobi',
      image:'https://images.unsplash.com/photo-1489824904134-891ab64532f1?w=400&q=70',
      inStock:true, description:'Brembo-spec sport brake kit. Front and rear pads + rotors. Improved stopping power.' },
    { id:'p6', name:'VW Transporter T5 DSG Gearbox', make:'VW', model:'Transporter T5',
      yearRange:'2010-2019', category:'Transmission', type:'OEM', condition:'Used', price:95000,
      seller:'Euro Auto Spares', sellerPhone:'0766666777', sellerVerified:false,
      city:'mombasa', location:'Bamburi, Mombasa',
      image:'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=400&q=70',
      inStock:true, description:'6-speed DSG gearbox. 70,000km. Tested and working. Mechatronics freshly serviced.' },
    { id:'p7', name:'Land Rover Defender Adaptive LED Headlights', make:'Land Rover', model:'Defender 110',
      yearRange:'2020-2024', category:'Lighting', type:'Aftermarket', condition:'New', price:42000,
      seller:'Land Parts Kenya', sellerPhone:'0777777888', sellerVerified:true,
      city:'nairobi', location:'Upper Hill, Nairobi',
      image:'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=400&q=70',
      inStock:true, description:'Full LED adaptive headlights. Plug and play installation. Better night visibility.' },
    { id:'p8', name:'Mazda CX-5 Air Suspension Compressor', make:'Mazda', model:'CX-5',
      yearRange:'2017-2023', category:'Suspension', type:'OEM', condition:'New', price:18500,
      seller:'Mazda Parts Africa', sellerPhone:'0788888999', sellerVerified:true,
      city:'nairobi', location:'Westlands, Nairobi',
      image:'https://images.unsplash.com/photo-1474978528675-4a50a4508dc7?w=400&q=70',
      inStock:true, description:'OEM suspension compressor. Smooth and quiet operation. Warranty included.' },
    { id:'p9', name:'Toyota Prado 150 Grille (Black)', make:'Toyota', model:'Prado 150',
      yearRange:'2010-2023', category:'Body Parts', type:'Aftermarket', condition:'New', price:12000,
      seller:'Prado Parts KE', sellerPhone:'0799900001', sellerVerified:true,
      city:'nairobi', location:'South B, Nairobi',
      image:'https://images.unsplash.com/photo-1489824904134-891ab64532f1?w=400&q=70',
      inStock:true, description:'Sport black honeycomb grille. Easy bolt-on installation. Premium ABS plastic.' },
    { id:'p10', name:'Nissan Navara Engine Mounts (Pair)', make:'Nissan', model:'Navara D40',
      yearRange:'2005-2015', category:'Engine', type:'Aftermarket', condition:'New', price:8500,
      seller:'Nissan Spares KE', sellerPhone:'0711100200', sellerVerified:false,
      city:'nairobi', location:'Enterprise Rd, Nairobi',
      image:'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=400&q=70',
      inStock:true, description:'Heavy-duty polyurethane engine mounts. Reduces vibration. Set of 2.' },
  ];

  const FINANCE_PARTNERS = [
    { name:'KCB Bank', logo:'🏦', rate:'12.5%', rateNum:12.5, maxLoan:'KES 10M', minDown:'20%', maxTerm:'72 months', phone:'0711087000' },
    { name:'Equity Bank', logo:'🟢', rate:'13%', rateNum:13, maxLoan:'KES 8M', minDown:'15%', maxTerm:'60 months', phone:'0763000000' },
    { name:'Co-op Bank', logo:'🤝', rate:'13.5%', rateNum:13.5, maxLoan:'KES 6M', minDown:'20%', maxTerm:'60 months', phone:'0703027000' },
    { name:'NCBA', logo:'💙', rate:'14%', rateNum:14, maxLoan:'KES 12M', minDown:'10%', maxTerm:'84 months', phone:'0711056444' },
    { name:'Absa Kenya', logo:'🔴', rate:'14.5%', rateNum:14.5, maxLoan:'KES 7M', minDown:'20%', maxTerm:'60 months', phone:'0709081000' },
  ];

  const INSPECTION_CENTERS = [
    { name:'NTSA Vehicle Inspection', location:'Embakasi, Nairobi', phone:'0709932000', official:true, types:['NTSA Annual Inspection','Fitness Certificate'], fee:'KES 700–1,200' },
    { name:'AA Kenya Inspection', location:'Upper Hill, Nairobi', phone:'0722202020', official:false, types:['Pre-Purchase Inspection','Mechanical Inspection'], fee:'KES 3,500–8,000' },
    { name:'AutoCheck Kenya', location:'Westlands, Nairobi', phone:'0712999888', official:false, types:['Pre-Purchase Inspection','Comprehensive Diagnostic'], fee:'KES 4,000–10,000' },
    { name:'CarScan Pro', location:'Karen, Nairobi', phone:'0733100200', official:false, types:['Pre-Purchase Inspection','Safety Check'], fee:'KES 2,500–6,000' },
  ];

  const TRANSPORT_PROVIDERS = [
    { name:'SafeCargo Transporters', phone:'0712111000', covered:'Nationwide', pricePerKm:50, minCharge:8000, types:['Open Carrier','Flatbed','Enclosed'], rating:4.7 },
    { name:'Kenya Auto Movers', phone:'0722222100', covered:'East Africa', pricePerKm:45, minCharge:7500, types:['Open Carrier','Flatbed'], rating:4.5 },
    { name:'ExpressHaul Kenya', phone:'0733333200', covered:'Nationwide', pricePerKm:55, minCharge:9000, types:['Enclosed','Flatbed'], rating:4.8 },
  ];

  /* ════════════════════════════════════════════════════
     MECHANIC HUB
  ════════════════════════════════════════════════════ */

  function getMechanics(){
    try{
      const saved=JSON.parse(localStorage.getItem('chpro_mechanic_listings')||'[]');
      return [...DEMO_MECHANICS,...saved];
    }catch(e){ return DEMO_MECHANICS; }
  }

  let activeMechSpec='all';

  function renderMechanicsGrid(){
    const grid=document.getElementById('mechGrid'); if(!grid) return;
    const q=(document.getElementById('mechSearch')?.value||'').toLowerCase().trim();
    const city=document.getElementById('mechCityFilter')?.value||'';
    const emergencyOnly=document.getElementById('mechEmergencyFilter')?.checked;
    const verifiedOnly=document.getElementById('mechVerifiedFilter')?.checked;
    let mechs=getMechanics();
    if(activeMechSpec!=='all') mechs=mechs.filter(m=>m.specialties.some(s=>s.toLowerCase().includes(activeMechSpec)));
    if(city) mechs=mechs.filter(m=>m.city===city);
    if(q) mechs=mechs.filter(m=>(m.name+' '+m.location+' '+m.specialties.join(' ')).toLowerCase().includes(q));
    if(emergencyOnly) mechs=mechs.filter(m=>m.emergency);
    if(verifiedOnly) mechs=mechs.filter(m=>m.verified);
    if(!mechs.length){
      grid.innerHTML=`<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:rgba(255,255,255,0.25);">
        <div style="font-size:48px;margin-bottom:14px;">🔧</div>
        <div style="font-size:15px;font-weight:700;">No mechanics found</div>
        <div style="font-size:12px;margin-top:6px;">Try clearing filters</div></div>`;
      return;
    }
    grid.innerHTML=mechs.map(m=>`
      <div class="chp-card" onclick="CarHubPro.openMechDetail('${m.id}')">
        <div style="height:160px;overflow:hidden;border-radius:14px 14px 0 0;position:relative;background:linear-gradient(135deg,#0d1a0d,#0d1020);">
          <img loading="lazy" src="${m.image}" alt="${m.name}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'">
          <div style="position:absolute;top:10px;left:10px;display:flex;gap:4px;flex-wrap:wrap;">
            ${m.verified?'<span class="chp-badge chp-badge-blue">✓ Verified</span>':''}
            ${m.emergency?'<span class="chp-badge chp-badge-red">⚡ 24/7</span>':''}
          </div>
          <div style="position:absolute;top:10px;right:10px;">
            <span class="chp-badge" style="${m.openNow?'background:rgba(113,255,0,0.15);border:1px solid rgba(113,255,0,0.35);color:#71ff00':'background:rgba(255,77,77,0.12);border:1px solid rgba(255,77,77,0.28);color:#ff6b6b'}">${m.openNow?'🟢 Open':'🔴 Closed'}</span>
          </div>
        </div>
        <div style="padding:14px;">
          <div style="font-size:15px;font-weight:900;color:white;margin-bottom:3px;">${m.name}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-bottom:6px;">📍 ${m.location}</div>
          <div style="font-size:11px;color:#ffc107;margin-bottom:8px;">★ ${m.rating} <span style="color:rgba(255,255,255,0.3);">(${m.reviews})</span> · ⏱ ${m.responseTime}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px;">
            ${m.specialties.slice(0,3).map(s=>`<span style="font-size:10px;font-weight:700;padding:3px 8px;background:rgba(113,255,0,0.07);border:1px solid rgba(113,255,0,0.18);color:#71ff00;border-radius:20px;">${s}</span>`).join('')}
            ${m.specialties.length>3?`<span style="font-size:10px;color:rgba(255,255,255,0.3);padding:3px 6px;">+${m.specialties.length-3}</span>`:''}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="font-size:13px;font-weight:800;color:#71ff00;">From ${kes(m.priceFrom)}</div>
            <div style="display:flex;gap:6px;">
              <a href="tel:${m.phone}" onclick="event.stopPropagation()" style="padding:7px 10px;background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.22);border-radius:9px;color:#71ff00;font-size:11px;font-weight:800;text-decoration:none;">📞</a>
              <button type="button" onclick="event.stopPropagation();CarHubPro.openMechBooking('${m.id}')" style="padding:7px 14px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-weight:900;font-size:11px;border:none;border-radius:9px;cursor:pointer;font-family:inherit;">Book</button>
            </div>
          </div>
        </div>
      </div>`).join('');
  }

  function setMechSpecFilter(spec, btn){
    activeMechSpec=spec;
    document.querySelectorAll('.mech-spec-chip').forEach(b=>b.classList.remove('active'));
    if(btn) btn.classList.add('active');
    renderMechanicsGrid();
  }

  function openMechDetail(id){
    const m=getMechanics().find(x=>x.id===id); if(!m) return;
    const content=document.getElementById('chpModalContent'); if(!content) return;
    const phone=(m.phone||'').replace(/^0/,'254');
    content.innerHTML=`
      <div style="height:200px;overflow:hidden;border-radius:14px;margin-bottom:14px;background:rgba(255,255,255,0.04);">
        <img loading="lazy" src="${m.image}" alt="${m.name}" style="width:100%;height:200px;object-fit:cover;" onerror="this.style.display='none'">
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:12px;">
        ${m.verified?'<span class="chp-badge chp-badge-blue">✓ Verified Garage</span>':''}
        ${m.emergency?'<span class="chp-badge chp-badge-red">⚡ 24/7 Emergency</span>':''}
        <span class="chp-badge" style="${m.openNow?'background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.3);color:#71ff00':'background:rgba(255,77,77,0.1);border:1px solid rgba(255,77,77,0.25);color:#ff6b6b'}">${m.openNow?'🟢 Open Now':'🔴 Closed'}</span>
      </div>
      <h2 style="font-size:20px;font-weight:900;color:white;margin-bottom:4px;">${m.name}</h2>
      <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-bottom:5px;">📍 ${m.location}</div>
      <div style="font-size:12px;color:#ffc107;margin-bottom:10px;">★ ${m.rating} (${m.reviews} reviews) · ⏱ Response: ${m.responseTime}</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.55);line-height:1.7;margin-bottom:14px;">${m.bio}</div>
      <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:7px;">Specialties</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;">
        ${m.specialties.map(s=>`<span style="font-size:11px;font-weight:700;padding:4px 11px;background:rgba(113,255,0,0.07);border:1px solid rgba(113,255,0,0.2);color:#71ff00;border-radius:20px;">✓ ${s}</span>`).join('')}
      </div>
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:12px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:12px;"><span style="color:rgba(255,255,255,0.4);">Owner</span><span style="font-weight:700;color:white;">${m.owner}</span></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:12px;"><span style="color:rgba(255,255,255,0.4);">Phone</span><a href="tel:${m.phone}" style="font-weight:700;color:#71ff00;">${m.phone}</a></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;"><span style="color:rgba(255,255,255,0.4);">Price from</span><span style="font-weight:700;color:#71ff00;">${kes(m.priceFrom)}</span></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
        <a href="tel:${m.phone}" style="padding:13px;background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.25);border-radius:12px;color:#71ff00;font-weight:900;font-size:13px;text-decoration:none;text-align:center;">📞 Call Now</a>
        <button type="button" onclick="closeChpModal();CarHubPro.openMechBooking('${m.id}')" style="padding:13px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-weight:900;font-size:13px;border:none;border-radius:12px;cursor:pointer;font-family:inherit;">📅 Book Service</button>
      </div>
      <a href="https://wa.me/${phone}?text=${encodeURIComponent('Hi! I found your garage on SOKONI Car Hub and need your services.')}" target="_blank" style="display:block;padding:12px;background:rgba(37,211,102,0.08);border:1px solid rgba(37,211,102,0.22);border-radius:12px;color:#25d366;font-weight:800;font-size:13px;text-align:center;text-decoration:none;"><i class="fab fa-whatsapp"></i> WhatsApp Mechanic</a>`;
    openChpModal(m.name,'🔧 Verified Garage');
  }

  function openMechBooking(id){
    const m=getMechanics().find(x=>x.id===id); if(!m) return;
    const content=document.getElementById('chpModalContent'); if(!content) return;
    const today=new Date().toISOString().split('T')[0];
    content.innerHTML=`
      <div style="background:rgba(113,255,0,0.05);border:1px solid rgba(113,255,0,0.15);border-radius:12px;padding:12px 14px;margin-bottom:16px;">
        <div style="font-size:14px;font-weight:900;color:white;">${m.name}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:2px;">📍 ${m.location} · ★ ${m.rating}</div>
      </div>
      <div style="margin-bottom:12px;"><label class="ch-input-label">Service Type*</label>
        <select class="ch-input" id="mechServiceType" style="margin-top:4px;">
          ${m.specialties.map(s=>`<option>${s}</option>`).join('')}
          <option value="Other">Other (describe below)</option>
        </select></div>
      <div style="margin-bottom:12px;"><label class="ch-input-label">Preferred Date*</label>
        <input class="ch-input" type="date" id="mechBookDate" min="${today}" value="${today}" style="margin-top:4px;"></div>
      <div style="margin-bottom:12px;"><label class="ch-input-label">Vehicle Registration / Make*</label>
        <input class="ch-input" id="mechVehicle" placeholder="e.g. KDA 001A — Toyota Land Cruiser" style="margin-top:4px;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
        <div><label class="ch-input-label">Your Name*</label><input class="ch-input" id="mechClientName" placeholder="Full name" style="margin-top:4px;"></div>
        <div><label class="ch-input-label">Phone*</label><input class="ch-input" type="tel" id="mechClientPhone" placeholder="07XXXXXXXX" style="margin-top:4px;"></div>
      </div>
      <div style="margin-bottom:16px;"><label class="ch-input-label">Problem Description</label>
        <textarea class="ch-input" id="mechProblem" rows="3" style="width:100%;resize:vertical;margin-top:4px;" placeholder="Describe the problem or service needed…"></textarea></div>
      <button type="button" onclick="CarHubPro.submitMechBooking('${m.id}')" style="width:100%;padding:14px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-weight:900;font-size:15px;border:none;border-radius:13px;cursor:pointer;font-family:inherit;">📅 Confirm Booking</button>
      <div id="mechBookMsg" style="font-size:12px;margin-top:10px;text-align:center;min-height:14px;"></div>`;
    openChpModal('Book Mechanic Service',m.name);
  }

  async function submitMechBooking(mechId){
    if(!rateLimit('mech_book',5,600000)){ toast('Too many bookings. Please wait.','error'); return; }
    const vehicle=document.getElementById('mechVehicle')?.value.trim();
    const name=document.getElementById('mechClientName')?.value.trim();
    const phone=document.getElementById('mechClientPhone')?.value.trim();
    const date=document.getElementById('mechBookDate')?.value;
    const service=document.getElementById('mechServiceType')?.value;
    const problem=document.getElementById('mechProblem')?.value.trim();
    const msgEl=document.getElementById('mechBookMsg');
    if(!vehicle||!name||!phone||!date){
      if(msgEl){msgEl.textContent='⚠️ Fill all required fields (*)';msgEl.style.color='#ff9800';} return;
    }
    const mech=getMechanics().find(x=>x.id===mechId);
    const booking={id:'MB'+Date.now().toString().slice(-8),type:'mechanic_booking',
      mechId,mechName:mech?.name||'',mechPhone:mech?.phone||'',
      serviceType:service,vehicle,clientName:name,clientPhone:phone,
      preferredDate:date,problem,status:'pending',createdAt:Date.now()};
    await fsWrite('mechanic_bookings',booking);
    saveBuyerActivity('mechanic_bookings',booking);
    const mPhone=(mech?.phone||'').replace(/^0/,'254').replace(/\D/g,'');
    if(mPhone){
      const wa=encodeURIComponent(`🔧 *SOKONI — Service Booking*\n\nRef: ${booking.id}\n👤 ${name} (${phone})\n🚗 ${vehicle}\n🛠️ ${service}\n📅 ${date}\n📝 ${problem||'No extra details'}\n\nPlease confirm availability.`);
      setTimeout(()=>window.open(`https://wa.me/${mPhone}?text=${wa}`,'_blank'),500);
    }
    if(msgEl){msgEl.innerHTML=`✅ Booking <strong>${_esc(booking.id)}</strong> sent to ${_esc(mech?.name||'')}! They will call you shortly.`;msgEl.style.color='#71ff00';}
    toast('✅ Mechanic booking submitted!');
    setTimeout(closeChpModal,2600);
  }

  /* ════════════════════════════════════════════════════
     SPARE PARTS MARKETPLACE
  ════════════════════════════════════════════════════ */

  function getParts(){
    try{
      const saved=JSON.parse(localStorage.getItem('chpro_parts_listings')||'[]');
      return [...DEMO_PARTS,...saved];
    }catch(e){ return DEMO_PARTS; }
  }

  let activePartCat='all';

  function renderPartsGrid(){
    const grid=document.getElementById('partsGrid'); if(!grid) return;
    const q=(document.getElementById('partsSearch')?.value||'').toLowerCase().trim();
    const make=document.getElementById('partsMakeFilter')?.value||'';
    const type=document.getElementById('partsTypeFilter')?.value||'';
    const cond=document.getElementById('partsConditionFilter')?.value||'';
    let parts=getParts();
    if(activePartCat!=='all') parts=parts.filter(p=>p.category===activePartCat);
    if(q) parts=parts.filter(p=>(p.name+' '+p.make+' '+p.model+' '+(p.description||'')).toLowerCase().includes(q));
    if(make) parts=parts.filter(p=>p.make===make);
    if(type) parts=parts.filter(p=>p.type===type);
    if(cond) parts=parts.filter(p=>p.condition===cond);
    if(!parts.length){
      grid.innerHTML=`<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:rgba(255,255,255,0.25);">
        <div style="font-size:48px;margin-bottom:14px;">🔩</div>
        <div style="font-size:15px;font-weight:700;">No parts found</div>
        <div style="font-size:12px;margin-top:6px;">Try different search terms</div></div>`;
      return;
    }
    grid.innerHTML=parts.map(p=>{
      const condColor=p.condition==='New'?'#71ff00':p.condition==='Used'?'#ff9800':'#00aaff';
      const ph=(p.sellerPhone||'').replace(/^0/,'254').replace(/\D/g,'');
      const wa=encodeURIComponent(`Hi! I saw your "${p.name}" on SOKONI Car Hub for ${kes(p.price)}. Is it available?`);
      return `<div class="chp-card" onclick="CarHubPro.openPartDetail('${p.id}')">
        <div style="height:160px;overflow:hidden;border-radius:14px 14px 0 0;position:relative;background:linear-gradient(135deg,#1a0d10,#0d1020);">
          <img loading="lazy" src="${p.image}" alt="${p.name}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'">
          <div style="position:absolute;top:10px;left:10px;display:flex;gap:4px;flex-wrap:wrap;">
            <span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:20px;background:rgba(0,0,0,0.7);border:1px solid ${condColor}4d;color:${condColor};">${p.condition}</span>
            <span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:20px;background:rgba(0,0,0,0.7);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);">${p.type}</span>
          </div>
          ${p.sellerVerified?'<div style="position:absolute;top:10px;right:10px;"><span class="chp-badge chp-badge-blue">✓ Verified</span></div>':''}
        </div>
        <div style="padding:13px;">
          <div style="font-size:13px;font-weight:900;color:white;margin-bottom:3px;line-height:1.3;">${p.name}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-bottom:4px;">${p.make} ${p.model} · ${p.yearRange}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.3);margin-bottom:10px;">📍 ${p.location}</div>
          <div style="font-size:20px;font-weight:900;color:#71ff00;margin-bottom:10px;">${kes(p.price)}</div>
          <div style="display:flex;gap:7px;">
            ${ph?`<a href="https://wa.me/${ph}?text=${wa}" target="_blank" onclick="event.stopPropagation()" style="flex:1;padding:9px;background:rgba(37,211,102,0.1);border:1px solid rgba(37,211,102,0.25);border-radius:9px;color:#25d366;font-size:11px;font-weight:800;text-decoration:none;text-align:center;"><i class="fab fa-whatsapp"></i> WhatsApp</a>`:''}
            <a href="tel:${p.sellerPhone}" onclick="event.stopPropagation()" style="padding:9px 12px;background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.2);border-radius:9px;color:#71ff00;font-size:12px;font-weight:800;text-decoration:none;">📞</a>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function setPartCatFilter(cat, btn){
    activePartCat=cat;
    document.querySelectorAll('.part-cat-chip').forEach(b=>b.classList.remove('active'));
    if(btn) btn.classList.add('active');
    renderPartsGrid();
  }

  function openPartDetail(id){
    const p=getParts().find(x=>x.id===id); if(!p) return;
    const ph=(p.sellerPhone||'').replace(/^0/,'254').replace(/\D/g,'');
    const wa=encodeURIComponent(`Hi ${p.seller}! I saw your "${p.name}" on SOKONI Car Hub for ${kes(p.price)}. Is it available?`);
    const condColor=p.condition==='New'?'#71ff00':p.condition==='Used'?'#ff9800':'#00aaff';
    const content=document.getElementById('chpModalContent'); if(!content) return;
    content.innerHTML=`
      <div style="height:200px;overflow:hidden;border-radius:14px;margin-bottom:14px;background:rgba(255,255,255,0.04);">
        <img loading="lazy" src="${p.image}" alt="${p.name}" style="width:100%;height:200px;object-fit:cover;" onerror="this.style.display='none'">
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:12px;">
        <span style="font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;border:1px solid ${condColor}4d;background:${condColor}1a;color:${condColor};">${p.condition}</span>
        <span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);">${p.type}</span>
        <span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;background:rgba(0,170,255,0.08);border:1px solid rgba(0,170,255,0.2);color:#00aaff;">${p.category}</span>
        ${p.sellerVerified?'<span class="chp-badge chp-badge-blue">✓ Verified Seller</span>':''}
      </div>
      <h2 style="font-size:18px;font-weight:900;color:white;line-height:1.3;margin-bottom:8px;">${p.name}</h2>
      <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-bottom:5px;">Fits: <strong style="color:white;">${p.make} ${p.model}</strong> (${p.yearRange})</div>
      <div style="font-size:12px;color:rgba(255,255,255,0.35);margin-bottom:12px;">📍 ${p.location}</div>
      <div style="font-size:26px;font-weight:900;color:#71ff00;margin-bottom:14px;">${kes(p.price)}</div>
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:12px;margin-bottom:14px;font-size:12px;color:rgba(255,255,255,0.55);line-height:1.7;">${p.description}</div>
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:12px;margin-bottom:16px;">
        <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:8px;">Seller</div>
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;"><span style="color:rgba(255,255,255,0.4);">Name</span><span style="font-weight:700;color:white;">${p.seller}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;"><span style="color:rgba(255,255,255,0.4);">Phone</span><a href="tel:${p.sellerPhone}" style="font-weight:700;color:#71ff00;">${p.sellerPhone}</a></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        ${ph?`<a href="https://wa.me/${ph}?text=${wa}" target="_blank" style="padding:13px;background:rgba(37,211,102,0.1);border:1px solid rgba(37,211,102,0.28);border-radius:12px;color:#25d366;font-weight:900;font-size:13px;text-align:center;text-decoration:none;"><i class="fab fa-whatsapp"></i> WhatsApp</a>`:''}
        <a href="tel:${p.sellerPhone}" style="padding:13px;background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.28);border-radius:12px;color:#71ff00;font-weight:900;font-size:13px;text-align:center;text-decoration:none;">📞 Call Seller</a>
      </div>`;
    openChpModal('Part Details','');
  }

  function openSellPartForm(){
    const content=document.getElementById('chpModalContent'); if(!content) return;
    content.innerHTML=`
      <div style="font-size:13px;color:rgba(255,255,255,0.45);margin-bottom:16px;">List your spare parts and reach thousands of Kenyan mechanics and car owners.</div>
      <div class="ch-form-grid">
        <div><label class="ch-input-label">Part Name*</label><input class="ch-input" id="spName" placeholder="e.g. Toyota Hilux Front Bumper" style="margin-top:4px;"></div>
        <div><label class="ch-input-label">Make*</label><input class="ch-input" id="spMake" placeholder="e.g. Toyota" style="margin-top:4px;"></div>
        <div><label class="ch-input-label">Model*</label><input class="ch-input" id="spModel" placeholder="e.g. Hilux" style="margin-top:4px;"></div>
        <div><label class="ch-input-label">Year Range</label><input class="ch-input" id="spYear" placeholder="e.g. 2018-2022" style="margin-top:4px;"></div>
        <div><label class="ch-input-label">Category</label>
          <select class="ch-input" id="spCategory" style="margin-top:4px;">
            <option>Body Parts</option><option>Engine</option><option>Transmission</option>
            <option>Brakes</option><option>Suspension</option><option>Electrical</option>
            <option>Lighting</option><option>Tyres & Wheels</option><option>Interior</option><option>Other</option>
          </select></div>
        <div><label class="ch-input-label">Type</label>
          <select class="ch-input" id="spType" style="margin-top:4px;"><option>OEM</option><option>Aftermarket</option></select></div>
        <div><label class="ch-input-label">Condition</label>
          <select class="ch-input" id="spCondition" style="margin-top:4px;"><option>New</option><option>Used</option><option>Refurbished</option></select></div>
        <div><label class="ch-input-label">Price (KES)*</label><input class="ch-input" type="number" id="spPrice" placeholder="25000" style="margin-top:4px;"></div>
        <div><label class="ch-input-label">Your Phone*</label><input class="ch-input" type="tel" id="spPhone" placeholder="07XXXXXXXX" style="margin-top:4px;"></div>
        <div><label class="ch-input-label">City</label>
          <select class="ch-input" id="spCity" style="margin-top:4px;">
            <option value="nairobi">Nairobi</option><option value="mombasa">Mombasa</option>
            <option value="kisumu">Kisumu</option><option value="nakuru">Nakuru</option><option value="eldoret">Eldoret</option>
          </select></div>
      </div>
      <div style="margin-bottom:11px;"><label class="ch-input-label">Location / Area</label><input class="ch-input" id="spLocation" placeholder="e.g. Industrial Area, Nairobi" style="margin-top:4px;width:100%;"></div>
      <div style="margin-bottom:11px;"><label class="ch-input-label">Description</label><textarea class="ch-input" id="spDesc" rows="3" style="width:100%;resize:vertical;margin-top:4px;" placeholder="Describe the part, condition, compatibility…"></textarea></div>
      <div style="margin-bottom:16px;"><label class="ch-input-label">Photo URL (optional)</label><input class="ch-input" id="spPhoto" placeholder="https://..." style="margin-top:4px;width:100%;"></div>
      <button type="button" onclick="CarHubPro.submitPartListing()" style="width:100%;padding:14px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-weight:900;font-size:15px;border:none;border-radius:13px;cursor:pointer;font-family:inherit;">🔩 List My Part</button>
      <div id="spMsg" style="font-size:12px;margin-top:10px;text-align:center;min-height:14px;"></div>`;
    openChpModal('Sell Spare Parts','');
  }

  async function submitPartListing(){
    if(!rateLimit('parts_list',5,300000)){toast('Too many submissions.','error');return;}
    const name=document.getElementById('spName')?.value.trim();
    const make=document.getElementById('spMake')?.value.trim();
    const model=document.getElementById('spModel')?.value.trim();
    const price=Number(document.getElementById('spPrice')?.value||0);
    const phone=document.getElementById('spPhone')?.value.trim();
    const msgEl=document.getElementById('spMsg');
    if(!name||!make||!model||price<1||!phone){
      if(msgEl){msgEl.textContent='⚠️ Fill all required fields (*)';msgEl.style.color='#ff9800';} return;
    }
    const user=JSON.parse(localStorage.getItem('sokoniUser')||'null');
    const part={id:'PART'+Date.now(),name,make,model,
      yearRange:document.getElementById('spYear')?.value.trim()||'',
      category:document.getElementById('spCategory')?.value||'Other',
      type:document.getElementById('spType')?.value||'OEM',
      condition:document.getElementById('spCondition')?.value||'New',
      price,seller:user?.name||'Private Seller',sellerPhone:phone,sellerVerified:false,
      city:document.getElementById('spCity')?.value||'nairobi',
      location:document.getElementById('spLocation')?.value.trim()||'Nairobi',
      description:document.getElementById('spDesc')?.value.trim()||'',
      image:document.getElementById('spPhoto')?.value.trim()||'',
      inStock:true,createdAt:Date.now()};
    const saved=JSON.parse(localStorage.getItem('chpro_parts_listings')||'[]');
    saved.unshift(part); localStorage.setItem('chpro_parts_listings',JSON.stringify(saved));
    await fsWrite('spare_parts',part);
    if(msgEl){msgEl.innerHTML='✅ Part listed! Buyers can now find it on SOKONI.';msgEl.style.color='#71ff00';}
    toast('✅ Spare part listed!');
    setTimeout(()=>{closeChpModal();renderPartsGrid();},2000);
  }

  /* ════════════════════════════════════════════════════
     ROADSIDE ASSISTANCE
  ════════════════════════════════════════════════════ */

  const RS_SERVICES={
    towing:{label:'Towing Service',provider:'0712000111',emoji:'🚛',eta:'20-40 min'},
    tire:{label:'Tyre Replacement',provider:'0722000222',emoji:'🛞',eta:'15-30 min'},
    battery:{label:'Battery Jump-Start',provider:'0733000333',emoji:'🔋',eta:'10-20 min'},
    fuel:{label:'Fuel Delivery',provider:'0744000444',emoji:'⛽',eta:'20-35 min'},
    lockout:{label:'Lockout Assistance',provider:'0755000555',emoji:'🔓',eta:'15-25 min'},
    mechanic:{label:'Emergency Mechanic',provider:'0712345678',emoji:'🔧',eta:'30-60 min'},
  };

  async function submitRoadsideRequest(type){
    if(!rateLimit('roadside',3,300000)){toast('Please wait before sending another request.','error');return;}
    const vehicle=document.getElementById('rsVehicle')?.value.trim();
    const location=document.getElementById('rsLocation')?.value.trim();
    const phone=document.getElementById('rsPhone')?.value.trim();
    const desc=document.getElementById('rsDesc')?.value.trim();
    const msgEl=document.getElementById('rsMsg');
    if(!vehicle||!location||!phone){
      if(msgEl){msgEl.textContent='⚠️ Vehicle, location and phone are required';msgEl.style.color='#ff9800';} return;
    }
    const svc=RS_SERVICES[type]||RS_SERVICES.towing;
    const req={id:'RS'+Date.now().toString().slice(-8),type:'roadside_request',
      serviceType:type,serviceLabel:svc.label,vehicle,location,phone,
      description:desc,status:'dispatched',eta:svc.eta,createdAt:Date.now()};
    await fsWrite('roadside_requests',req);
    saveBuyerActivity('roadside_requests',req);
    const prov=svc.provider.replace(/^0/,'254');
    const wa=encodeURIComponent(`${svc.emoji} *SOKONI ROADSIDE ALERT*\n\nRef: ${req.id}\n📞 ${phone}\n🚗 ${vehicle}\n📍 ${location}\n🛠️ ${svc.label}\n📝 ${desc||'No extra details'}\n\nPlease respond urgently.`);
    setTimeout(()=>window.open(`https://wa.me/${prov}?text=${wa}`,'_blank'),400);
    const panel=document.getElementById('rsFormPanel');
    const result=document.getElementById('rsResultPanel');
    if(panel) panel.style.display='none';
    if(result){
      result.style.display='block';
      result.innerHTML=`
        <div style="text-align:center;padding:20px 0;">
          <div style="font-size:56px;margin-bottom:16px;animation:sosPulse 1.5s infinite;">${svc.emoji}</div>
          <div style="font-size:18px;font-weight:900;color:#71ff00;margin-bottom:8px;">${svc.label} Dispatched!</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.4);margin-bottom:16px;">Ref: <strong style="color:white;">${req.id}</strong></div>
          <div style="background:rgba(113,255,0,0.06);border:1px solid rgba(113,255,0,0.2);border-radius:14px;padding:16px;margin-bottom:16px;">
            <div style="font-size:26px;font-weight:900;color:#71ff00;">ETA: ${svc.eta}</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;">Estimated arrival at your location</div>
          </div>
          <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:16px;line-height:1.7;">Stay with your vehicle. A technician will call you at <strong style="color:white;">${phone}</strong> shortly.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
            <a href="tel:999" style="padding:12px;background:rgba(255,33,33,0.12);border:1px solid rgba(255,33,33,0.3);border-radius:11px;color:#ff3333;font-weight:900;font-size:13px;text-decoration:none;text-align:center;">🚨 Police 999</a>
            <a href="tel:0800723000" style="padding:12px;background:rgba(255,100,0,0.1);border:1px solid rgba(255,100,0,0.25);border-radius:11px;color:#ff9800;font-weight:900;font-size:13px;text-decoration:none;text-align:center;">🏥 Ambulance</a>
          </div>
          <button type="button" onclick="CarHubPro.resetRoadsideForm()" style="width:100%;padding:12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:11px;color:rgba(255,255,255,0.5);font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;">Request Another Service</button>
        </div>`;
    }
    toast('✅ Roadside assistance dispatched!');
  }

  function resetRoadsideForm(){
    const panel=document.getElementById('rsFormPanel');
    const result=document.getElementById('rsResultPanel');
    if(panel){panel.style.display='block';['rsVehicle','rsLocation','rsPhone','rsDesc'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});}
    if(result) result.style.display='none';
  }

  /* ════════════════════════════════════════════════════
     VEHICLE FINANCING
  ════════════════════════════════════════════════════ */

  function calcFinancing(){
    const vehiclePrice=Number(document.getElementById('finVehiclePrice')?.value||0);
    const downPct=Number(document.getElementById('finDownPaymentPct')?.value||20);
    const termMonths=Number(document.getElementById('finTerm')?.value||48);
    const rate=Number(document.getElementById('finRate')?.value||13);
    if(vehiclePrice<1) return;
    const downPayment=Math.round(vehiclePrice*downPct/100);
    const loanAmount=vehiclePrice-downPayment;
    const mr=rate/100/12;
    const monthly=mr>0
      ?Math.round(loanAmount*mr*Math.pow(1+mr,termMonths)/(Math.pow(1+mr,termMonths)-1))
      :Math.round(loanAmount/termMonths);
    const totalRepayable=monthly*termMonths;
    const totalInterest=totalRepayable-loanAmount;
    const res=document.getElementById('finResult'); if(!res) return;
    res.style.display='block';
    res.innerHTML=`
      <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:10px;">Loan Breakdown</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
        <div style="background:rgba(113,255,0,0.06);border:1px solid rgba(113,255,0,0.18);border-radius:12px;padding:12px;text-align:center;">
          <div style="font-size:20px;font-weight:900;color:#71ff00;">${kes(monthly)}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-top:3px;">Monthly Payment</div>
        </div>
        <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:12px;text-align:center;">
          <div style="font-size:20px;font-weight:900;color:white;">${kes(loanAmount)}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-top:3px;">Loan Amount</div>
        </div>
        <div style="background:rgba(0,170,255,0.05);border:1px solid rgba(0,170,255,0.15);border-radius:12px;padding:12px;text-align:center;">
          <div style="font-size:18px;font-weight:900;color:#00aaff;">${kes(downPayment)}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-top:3px;">Down Payment (${downPct}%)</div>
        </div>
        <div style="background:rgba(255,152,0,0.05);border:1px solid rgba(255,152,0,0.15);border-radius:12px;padding:12px;text-align:center;">
          <div style="font-size:18px;font-weight:900;color:#ff9800;">${kes(totalInterest)}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-top:3px;">Total Interest</div>
        </div>
      </div>
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:11px;padding:12px;font-size:12px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:5px;"><span style="color:rgba(255,255,255,0.4);">Loan Term</span><span style="font-weight:700;color:white;">${termMonths} months</span></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:5px;"><span style="color:rgba(255,255,255,0.4);">Annual Interest Rate</span><span style="font-weight:700;color:white;">${rate}% p.a.</span></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:rgba(255,255,255,0.4);">Total Repayable</span><span style="font-weight:800;color:#71ff00;">${kes(totalRepayable)}</span></div>
      </div>`;
  }

  async function submitFinancingApplication(){
    if(!rateLimit('finance_app',3,3600000)){toast('Please wait before reapplying.','error');return;}
    const name=document.getElementById('finName')?.value.trim();
    const phone=document.getElementById('finPhone')?.value.trim();
    const income=Number(document.getElementById('finIncome')?.value||0);
    const vehiclePrice=Number(document.getElementById('finVehiclePrice')?.value||0);
    const partner=document.getElementById('finPartner')?.value;
    const msgEl=document.getElementById('finAppMsg');
    if(!name||!phone||income<1||vehiclePrice<1||!partner){
      if(msgEl){msgEl.textContent='⚠️ Fill all fields';msgEl.style.color='#ff9800';} return;
    }
    const app={id:'FIN'+Date.now().toString().slice(-8),type:'financing_application',
      applicantName:name,phone,monthlyIncome:income,vehiclePrice,preferredPartner:partner,
      downPaymentPct:document.getElementById('finDownPaymentPct')?.value||20,
      loanTerm:document.getElementById('finTerm')?.value||48,
      interestRate:document.getElementById('finRate')?.value||13,
      status:'pending',createdAt:Date.now()};
    await fsWrite('financing_applications',app);
    saveBuyerActivity('financing_applications',app);
    // WhatsApp to bank
    const bankInfo=FINANCE_PARTNERS.find(p=>p.name===partner);
    if(bankInfo){
      const ph=bankInfo.phone.replace(/^0/,'254');
      const wa=encodeURIComponent(`💰 *SOKONI — Loan Application*\n\nRef: ${app.id}\nApplicant: ${name}\nPhone: ${phone}\nMonthly Income: ${kes(income)}\nVehicle Price: ${kes(vehiclePrice)}\nTerm: ${app.loanTerm} months\n\nPlease contact the applicant.`);
      setTimeout(()=>window.open(`https://wa.me/${ph}?text=${wa}`,'_blank'),400);
    }
    const _ce=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    if(msgEl){msgEl.innerHTML=`✅ Application <strong>${_ce(app.id)}</strong> sent to ${_ce(partner)}! A loan officer will contact you within 24 hours.`;msgEl.style.color='#71ff00';}
    toast('✅ Financing application submitted!');
  }

  /* ════════════════════════════════════════════════════
     VEHICLE INSPECTION
  ════════════════════════════════════════════════════ */

  async function submitInspectionBooking(){
    if(!rateLimit('inspection',5,300000)){toast('Too many requests.','error');return;}
    const vehicle=document.getElementById('inspVehicle')?.value.trim();
    const type=document.getElementById('inspType')?.value;
    const center=document.getElementById('inspCenter')?.value;
    const date=document.getElementById('inspDate')?.value;
    const phone=document.getElementById('inspPhone')?.value.trim();
    const msgEl=document.getElementById('inspMsg');
    if(!vehicle||!type||!date||!phone){
      if(msgEl){msgEl.textContent='⚠️ Fill all required fields';msgEl.style.color='#ff9800';} return;
    }
    const booking={id:'INSP'+Date.now().toString().slice(-8),type:'inspection_booking',
      vehicle,inspectionType:type,preferredCenter:center,
      preferredDate:date,phone,status:'pending',createdAt:Date.now()};
    await fsWrite('inspection_bookings',booking);
    saveBuyerActivity('inspection_bookings',booking);
    const c=INSPECTION_CENTERS.find(x=>x.name===center)||INSPECTION_CENTERS[1];
    const ph=c.phone.replace(/^0/,'254');
    const wa=encodeURIComponent(`🔍 *SOKONI — Inspection Booking*\n\nRef: ${booking.id}\n📞 ${phone}\n🚗 ${vehicle}\n🔍 ${type}\n📅 ${date}\n\nPlease confirm the appointment.`);
    setTimeout(()=>window.open(`https://wa.me/${ph}?text=${wa}`,'_blank'),400);
    if(msgEl){msgEl.innerHTML=`✅ Booking <strong>${_esc(booking.id)}</strong> confirmed! ${_esc(c.name)} will contact you at <strong>${_esc(phone)}</strong>.`;msgEl.style.color='#71ff00';}
    toast('✅ Inspection booked!');
  }

  /* ════════════════════════════════════════════════════
     CAR TRANSPORT
  ════════════════════════════════════════════════════ */

  function calcTransportQuote(){
    const from=document.getElementById('transFrom')?.value||'';
    const to=document.getElementById('transTo')?.value||'';
    const vType=document.getElementById('transVehicleType')?.value||'sedan';
    const svcType=document.getElementById('transServiceType')?.value||'open-carrier';
    const result=document.getElementById('transQuoteResult');
    if(!from||!to||!result) return;
    if(from===to){result.innerHTML='<div style="color:#ff9800;font-size:12px;padding:10px 0;">⚠️ Pickup and delivery must be different cities</div>';result.style.display='block';return;}
    const fc=CITIES[from]||CITIES.nairobi, tc=CITIES[to]||CITIES.mombasa;
    const dist=Math.round(Math.sqrt(Math.pow((fc.lat-tc.lat)*111,2)+Math.pow((fc.lng-tc.lng)*85,2)));
    const vMult={sedan:1,suv:1.2,pickup:1.1,van:1.3,truck:1.5}[vType]||1;
    const sMult={'open-carrier':1,'enclosed':1.45,'flatbed':1.2}[svcType]||1;
    const quote=Math.max(8000,Math.round(dist*50*vMult*sMult/500)*500);
    result.style.display='block';
    result.innerHTML=`
      <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:8px;">Transport Quote</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px;">
        <div style="background:rgba(113,255,0,0.06);border:1px solid rgba(113,255,0,0.18);border-radius:11px;padding:12px;text-align:center;">
          <div style="font-size:16px;font-weight:900;color:#71ff00;">${kes(quote)}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-top:2px;">Est. Cost</div>
        </div>
        <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.07);border-radius:11px;padding:12px;text-align:center;">
          <div style="font-size:16px;font-weight:900;color:white;">~${dist}km</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-top:2px;">Distance</div>
        </div>
        <div style="background:rgba(0,170,255,0.05);border:1px solid rgba(0,170,255,0.15);border-radius:11px;padding:12px;text-align:center;">
          <div style="font-size:16px;font-weight:900;color:#00aaff;">1-2 days</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-top:2px;">Delivery</div>
        </div>
      </div>
      <div style="font-size:11px;color:rgba(255,255,255,0.3);line-height:1.6;">Quote includes loading, transit, unloading and basic transit insurance. Final price confirmed after vehicle inspection.</div>`;
  }

  async function submitTransportRequest(){
    if(!rateLimit('transport',5,300000)){toast('Too many requests.','error');return;}
    const vehicle=document.getElementById('transVehicle')?.value.trim();
    const from=document.getElementById('transFrom')?.value;
    const to=document.getElementById('transTo')?.value;
    const date=document.getElementById('transDate')?.value;
    const phone=document.getElementById('transPhone')?.value.trim();
    const msgEl=document.getElementById('transMsg');
    if(!vehicle||!from||!to||!date||!phone){
      if(msgEl){msgEl.textContent='⚠️ Fill all required fields';msgEl.style.color='#ff9800';} return;
    }
    if(from===to){if(msgEl){msgEl.textContent='⚠️ Pickup and delivery must be different cities';msgEl.style.color='#ff9800';} return;}
    const req={id:'TR'+Date.now().toString().slice(-8),type:'transport_request',
      vehicle,from,to,
      vehicleType:document.getElementById('transVehicleType')?.value||'sedan',
      serviceType:document.getElementById('transServiceType')?.value||'open-carrier',
      preferredDate:date,phone,status:'pending',createdAt:Date.now()};
    await fsWrite('transport_requests',req);
    saveBuyerActivity('transport_requests',req);
    const prov=TRANSPORT_PROVIDERS[0];
    const ph=prov.phone.replace(/^0/,'254');
    const wa=encodeURIComponent(`🚛 *SOKONI — Car Transport*\n\nRef: ${req.id}\n📞 ${phone}\n🚗 ${vehicle} (${req.vehicleType})\n📍 ${(CITIES[from]||{label:from}).label} → ${(CITIES[to]||{label:to}).label}\n📅 ${date}\n🚛 ${req.serviceType}\n\nPlease provide a quote.`);
    setTimeout(()=>window.open(`https://wa.me/${ph}?text=${wa}`,'_blank'),400);
    if(msgEl){msgEl.innerHTML=`✅ Request <strong>${_esc(req.id)}</strong> sent! Provider will contact you at ${_esc(phone)}.`;msgEl.style.color='#71ff00';}
    toast('✅ Transport request submitted!');
  }

  /* ════════════════════════════════════════════════════
     BUYER DASHBOARD
  ════════════════════════════════════════════════════ */

  function renderBuyerDashboard(){
    const container=document.getElementById('buyerDashContent'); if(!container) return;
    const carBookings=JSON.parse(localStorage.getItem('sokoniCarBookings')||'[]');
    const savedCars=JSON.parse(localStorage.getItem('chpro_saved_cars')||'[]');
    const mechBookings=getBuyerActivity('mechanic_bookings');
    const inspBookings=getBuyerActivity('inspection_bookings');
    const finApps=getBuyerActivity('financing_applications');
    const roadsideReqs=getBuyerActivity('roadside_requests');
    const transReqs=getBuyerActivity('transport_requests');

    container.innerHTML=`
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:24px;">
        ${[
          {val:carBookings.length,lbl:'Car Rentals',col:'#71ff00',icon:'🚗'},
          {val:savedCars.length,lbl:'Saved Vehicles',col:'#00aaff',icon:'❤️'},
          {val:mechBookings.length,lbl:'Mechanic Jobs',col:'#ff9800',icon:'🔧'},
          {val:finApps.length,lbl:'Finance Apps',col:'#a78bfa',icon:'💰'},
          {val:inspBookings.length,lbl:'Inspections',col:'#34d399',icon:'🔍'},
          {val:roadsideReqs.length+transReqs.length,lbl:'Other Requests',col:'#f87171',icon:'📦'},
        ].map(d=>`<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:14px;text-align:center;">
          <div style="font-size:24px;margin-bottom:4px;">${d.icon}</div>
          <div style="font-size:22px;font-weight:900;color:${d.col};margin-bottom:2px;">${d.val}</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.35);font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${d.lbl}</div>
        </div>`).join('')}
      </div>

      ${savedCars.length?`
      <div style="margin-bottom:24px;">
        <div style="font-size:13px;font-weight:800;color:white;margin-bottom:12px;display:flex;align-items:center;gap:6px;"><span style="color:#00aaff;">❤️</span> Saved Vehicles (${savedCars.length})</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;">
          ${savedCars.map(c=>`<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;cursor:pointer;" onclick="showTab('browse',null)">
            <img loading="lazy" src="${c.image||''}" style="width:100%;height:90px;object-fit:cover;" onerror="this.style.display='none'">
            <div style="padding:10px;">
              <div style="font-size:12px;font-weight:800;color:white;">${c.make} ${c.model}</div>
              <div style="font-size:10px;color:rgba(255,255,255,0.4);">${c.year} · ${c.city}</div>
              <div style="font-size:14px;font-weight:900;color:#71ff00;margin-top:5px;">KES ${(c.priceDay||0).toLocaleString()}/day</div>
            </div>
          </div>`).join('')}
        </div>
      </div>`:''}

      ${carBookings.length?`
      <div style="margin-bottom:22px;">
        <div style="font-size:13px;font-weight:800;color:white;margin-bottom:10px;">🚗 Car Rental Bookings</div>
        ${carBookings.slice(0,5).map(b=>`<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:12px 14px;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div><div style="font-size:13px;font-weight:800;color:white;">${b.carMake||''} ${b.carModel||''}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);">${b.pickupDate||''} → ${b.returnDate||''}</div></div>
          <div style="text-align:right;"><div style="font-size:13px;font-weight:900;color:#71ff00;">KES ${(b.total||0).toLocaleString()}</div>
          <span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:20px;background:rgba(${b.status==='active'?'113,255,0':'255,255,255'},0.08);border:1px solid rgba(${b.status==='active'?'113,255,0':'255,255,255'},0.18);color:${b.status==='active'?'#71ff00':'rgba(255,255,255,0.4)'};">${b.status||'pending'}</span></div>
        </div>`).join('')}
      </div>`:''}

      ${mechBookings.length?`
      <div style="margin-bottom:22px;">
        <div style="font-size:13px;font-weight:800;color:white;margin-bottom:10px;">🔧 Mechanic Bookings</div>
        ${mechBookings.slice(0,3).map(b=>`<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:12px 14px;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div><div style="font-size:13px;font-weight:800;color:white;">${b.mechName||''}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);">${b.serviceType||''} · ${b.vehicle||''}</div></div>
          <span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:20px;background:rgba(255,152,0,0.1);border:1px solid rgba(255,152,0,0.25);color:#ff9800;">${b.id||''}</span>
        </div>`).join('')}
      </div>`:''}

      ${finApps.length?`
      <div style="margin-bottom:22px;">
        <div style="font-size:13px;font-weight:800;color:white;margin-bottom:10px;">💰 Financing Applications</div>
        ${finApps.slice(0,3).map(a=>`<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:12px 14px;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div><div style="font-size:13px;font-weight:800;color:white;">${a.preferredPartner||''}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);">Vehicle: ${kes(a.vehiclePrice||0)}</div></div>
          <span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:20px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25);color:#a78bfa;">Pending</span>
        </div>`).join('')}
      </div>`:''}

      ${!carBookings.length&&!savedCars.length&&!mechBookings.length?`
      <div style="text-align:center;padding:60px 20px;color:rgba(255,255,255,0.25);">
        <div style="font-size:56px;margin-bottom:16px;">🚗</div>
        <div style="font-size:16px;font-weight:700;margin-bottom:8px;">Your Dashboard is Empty</div>
        <div style="font-size:13px;margin-bottom:20px;">Browse cars, book mechanics, or apply for financing to get started.</div>
        <button type="button" onclick="showTab('browse',null)" style="padding:12px 24px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-weight:900;border:none;border-radius:12px;cursor:pointer;font-family:inherit;">Browse Cars</button>
      </div>`:''}`;
  }

  /* ════════════════════════════════════════════════════
     DEALER ANALYTICS
  ════════════════════════════════════════════════════ */

  function renderDealerAnalytics(){
    const container=document.getElementById('dealerAnalyticsPanel'); if(!container) return;
    const cars=JSON.parse(localStorage.getItem('sokoniCarFleet')||'[]');
    const bookings=JSON.parse(localStorage.getItem('sokoniCarBookings')||'[]');
    const totalRevenue=bookings.reduce((s,b)=>s+(b.total||0),0);
    const activeCount=bookings.filter(b=>b.status==='active').length;
    const completedCount=bookings.filter(b=>b.status==='completed').length;
    const avgRev=bookings.length?Math.round(totalRevenue/bookings.length):0;
    container.innerHTML=`
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px;">
        ${[
          {val:kes(totalRevenue),lbl:'Total Revenue',col:'#71ff00'},
          {val:activeCount,lbl:'Active Rentals',col:'#00aaff'},
          {val:completedCount,lbl:'Completed',col:'#34d399'},
          {val:kes(avgRev),lbl:'Avg Per Booking',col:'#ffc107'},
          {val:cars.length,lbl:'Total Listings',col:'#a78bfa'},
          {val:cars.filter(c=>c.status==='available').length,lbl:'Available Now',col:'#71ff00'},
        ].map(d=>`<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:13px;padding:12px;text-align:center;">
          <div style="font-size:16px;font-weight:900;color:${d.col};margin-bottom:3px;">${d.val}</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.35);font-weight:700;text-transform:uppercase;">${d.lbl}</div>
        </div>`).join('')}
      </div>`;
  }

  /* ════════════════════════════════════════════════════
     AI PRICE ESTIMATION
  ════════════════════════════════════════════════════ */

  function estimateVehiclePrice(){
    const make=document.getElementById('aiMake')?.value.trim();
    const model=document.getElementById('aiModel')?.value.trim();
    const year=Number(document.getElementById('aiYear')?.value||0);
    const mileage=Number(document.getElementById('aiMileage')?.value||0);
    const condition=document.getElementById('aiCondition')?.value||'good';
    const msgEl=document.getElementById('aiResult');
    if(!make||!model||!year){
      if(msgEl){msgEl.style.display='block';msgEl.innerHTML='<div style="color:#ff9800;font-size:12px;padding:8px 0;">⚠️ Enter make, model and year</div>';}
      return;
    }
    const age=Math.max(0,2026-year);
    const ageD=Math.max(0.3,1-age*0.08);
    const mileD=mileage>0?Math.max(0.45,1-mileage/500000*0.45):1;
    const condM={excellent:1.18,good:1.0,fair:0.80,poor:0.58}[condition]||1;
    const makeM={Toyota:1.22,LandRover:1.85,BMW:1.55,Mercedes:1.65,Audi:1.42,Subaru:1.12,Honda:1.02,Nissan:0.95,Mazda:0.9,Hyundai:0.85,Mitsubishi:0.88,VW:0.95,Ford:0.90}[make.replace(/[-\s]/g,'')]||1.0;
    const base=900000;
    const est=Math.round(base*ageD*mileD*condM*makeM/10000)*10000;
    const low=Math.round(est*0.86/10000)*10000;
    const high=Math.round(est*1.14/10000)*10000;
    if(msgEl){
      msgEl.style.display='block';
      msgEl.innerHTML=`
        <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.35);text-transform:uppercase;margin-bottom:10px;">🤖 AI Price Estimate — ${make} ${model} ${year}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px;">
          <div style="background:rgba(255,77,77,0.07);border:1px solid rgba(255,77,77,0.2);border-radius:11px;padding:12px;text-align:center;">
            <div style="font-size:11px;font-weight:800;color:#ff6b6b;margin-bottom:4px;">Low</div>
            <div style="font-size:14px;font-weight:900;color:white;">${kes(low)}</div>
          </div>
          <div style="background:rgba(113,255,0,0.07);border:1px solid rgba(113,255,0,0.25);border-radius:11px;padding:12px;text-align:center;">
            <div style="font-size:11px;font-weight:800;color:#71ff00;margin-bottom:4px;">Mid Market</div>
            <div style="font-size:16px;font-weight:900;color:#71ff00;">${kes(est)}</div>
          </div>
          <div style="background:rgba(0,170,255,0.07);border:1px solid rgba(0,170,255,0.2);border-radius:11px;padding:12px;text-align:center;">
            <div style="font-size:11px;font-weight:800;color:#00aaff;margin-bottom:4px;">High</div>
            <div style="font-size:14px;font-weight:900;color:white;">${kes(high)}</div>
          </div>
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,0.35);line-height:1.7;background:rgba(255,255,255,0.02);border-radius:10px;padding:10px;">
          <strong style="color:rgba(255,255,255,0.5);">Based on:</strong> Kenya market data · ${age}-year-old vehicle · ${mileage.toLocaleString()}km · ${condition} condition · ${make} brand premium.<br>
          <span style="color:rgba(255,255,255,0.2);">This is an AI estimate. Actual price varies with service history, specs, and local demand.</span>
        </div>`;
    }
  }

  /* ════════════════════════════════════════════════════
     SAVE & SHARE VEHICLE
  ════════════════════════════════════════════════════ */

  function saveVehicle(carId){
    try{
      const allCars=JSON.parse(localStorage.getItem('sokoniCarFleet')||'[]');
      const demos=window.DEMO_CARS||[];
      const car=[...allCars,...demos].find(c=>c.id===carId);
      if(!car){toast('Vehicle not found.','error');return;}
      const saved=JSON.parse(localStorage.getItem('chpro_saved_cars')||'[]');
      if(saved.find(s=>s.id===carId)){toast('Already in your saved list!');return;}
      saved.unshift(car);
      localStorage.setItem('chpro_saved_cars',JSON.stringify(saved.slice(0,50)));
      toast('❤️ Vehicle saved to your dashboard!');
    }catch(e){toast('Could not save vehicle.','error');}
  }

  function shareVehicle(carId,name){
    const url=`${location.origin}${location.pathname}?tab=browse&car=${carId}`;
    if(navigator.share){
      navigator.share({title:name+' on SOKONI Car Hub',text:`Check out this ${name} on SOKONI Car Hub!`,url}).catch(()=>{});
    } else if(navigator.clipboard){
      navigator.clipboard.writeText(url).then(()=>toast('📋 Link copied!')).catch(()=>toast(url));
    } else {
      toast('Copy: '+url);
    }
  }

  /* ════════════════════════════════════════════════════
     SHARED MODAL SYSTEM
  ════════════════════════════════════════════════════ */

  function openChpModal(title, subtitle){
    const overlay=document.getElementById('chpModalOverlay');
    const t=document.getElementById('chpModalTitle');
    const s=document.getElementById('chpModalSubtitle');
    if(t) t.textContent=title;
    if(s) s.textContent=subtitle;
    if(overlay) overlay.classList.add('open');
  }

  function closeChpModal(){
    const overlay=document.getElementById('chpModalOverlay');
    if(overlay) overlay.classList.remove('open');
  }

  window.closeChpModal=closeChpModal;

  /* ════════════════════════════════════════════════════
     INIT
  ════════════════════════════════════════════════════ */

  function init(){
    const overlay=document.getElementById('chpModalOverlay');
    if(overlay) overlay.addEventListener('click',e=>{if(e.target===overlay)closeChpModal();});

    const origShowTab=window.showTab;
    if(typeof origShowTab==='function'){
      window.showTab=function(name,btn,skip){
        origShowTab(name,btn,skip);
        if(name==='mechanics') setTimeout(renderMechanicsGrid,50);
        if(name==='parts') setTimeout(renderPartsGrid,50);
        if(name==='buyer') setTimeout(renderBuyerDashboard,50);
        if(name==='fleet') setTimeout(renderDealerAnalytics,100);
      };
    }
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',init);
  } else {
    setTimeout(init,200);
  }

  /* Public API */
  return {
    renderMechanicsGrid, setMechSpecFilter, openMechDetail, openMechBooking, submitMechBooking,
    renderPartsGrid, setPartCatFilter, openPartDetail, openSellPartForm, submitPartListing,
    submitRoadsideRequest, resetRoadsideForm,
    calcFinancing, submitFinancingApplication,
    submitInspectionBooking,
    calcTransportQuote, submitTransportRequest,
    renderBuyerDashboard, renderDealerAnalytics,
    estimateVehiclePrice,
    saveVehicle, shareVehicle,
    openChpModal, closeChpModal,
    FINANCE_PARTNERS, INSPECTION_CENTERS, TRANSPORT_PROVIDERS,
  };
})();
