/* ============================================================
   SOKONI HUB REGISTER  — universal business / provider sign-up
   Works on every hub and service page.
   Call:  HubRegister.open({ hub:'fitness', category:'gym' })
   or just drop <button onclick="HubRegister.open()"> anywhere.
   ============================================================ */
(function () {
  'use strict';

  /* ── Category master list ─────────────────────────────────── */
  var CATS = [
    /* Shopping & Retail */
    { id:'retail-shop',      label:'Retail Shop / Boutique',         hub:'shopping',      emoji:'🛍️' },
    { id:'wholesale',        label:'Wholesale / Distributor',         hub:'shopping',      emoji:'📦' },
    { id:'supermarket',      label:'Supermarket / Minimart',          hub:'shopping',      emoji:'🏪' },
    /* 2026-10-03 (sokoni-e3, Digital = device RETAIL on merchant-v2): a phone / laptop SHOP had no intake id — the only
       'electronics' option was phone-repair (it_services → a repair dashboard). Maps to C1 'electronics' → seller. */
    { id:'electronics',      label:'Phones, Laptops & Electronics Shop', hub:'shopping',    emoji:'📱' },
    { id:'hardware',         label:'Hardware / Building Materials',    hub:'construction',  emoji:'🧱' },
    { id:'water-supplier',   label:'Water Supplier / Refill Station', hub:'shopping',      emoji:'💧' },
    /* Food & Beverage */
    { id:'restaurant',       label:'Restaurant / Hotel',              hub:'food',          emoji:'🍽️' },
    { id:'cafe',             label:'Café / Coffee Shop',              hub:'food',          emoji:'☕' },
    { id:'fast-food',        label:'Fast Food / Chips Mwitu',         hub:'food',          emoji:'🍟' },
    { id:'bakery',           label:'Bakery / Confectionery',          hub:'food',          emoji:'🥐' },
    { id:'catering',         label:'Catering / Events Catering',      hub:'food',          emoji:'🍲' },
    { id:'food-truck',       label:'Food Truck / Kiosk / Mkokoteni',  hub:'food',          emoji:'🚚' },
    { id:'butcher',          label:'Butchery / Deli',                 hub:'food',          emoji:'🥩' },
    /* Fitness & Wellness */
    { id:'gym',              label:'Gym / Fitness Centre',            hub:'fitness',       emoji:'🏋️' },
    { id:'yoga-studio',      label:'Yoga / Pilates Studio',           hub:'fitness',       emoji:'🧘' },
    { id:'martial-arts',     label:'Martial Arts / Boxing',           hub:'fitness',       emoji:'🥋' },
    { id:'dance-fitness',    label:'Dance Fitness / Zumba',           hub:'fitness',       emoji:'💃' },
    { id:'nutrition',        label:'Nutritionist / Dietitian',        hub:'fitness',       emoji:'🥗' },
    { id:'spinning',         label:'Spinning / Cycling Studio',       hub:'fitness',       emoji:'🚴' },
    /* Sports */
    { id:'football-club',    label:'Football Club / Academy',         hub:'sports',        emoji:'⚽' },
    { id:'basketball',       label:'Basketball / Netball Team',       hub:'sports',        emoji:'🏀' },
    { id:'swimming-pool',    label:'Swimming Pool / Aquatic Centre',  hub:'sports',        emoji:'🏊' },
    { id:'sports-venue',     label:'Sports Ground / Venue',           hub:'sports',        emoji:'🏟️' },
    { id:'sports-equipment', label:'Sports Equipment Shop',           hub:'sports',        emoji:'🏅' },
    { id:'coach',            label:'Sports Coach / Trainer',          hub:'sports',        emoji:'🏆' },
    /* Healthcare */
    { id:'hospital',         label:'Hospital / Clinic',               hub:'healthcare',    emoji:'🏥' },
    { id:'pharmacy',         label:'Pharmacy / Chemist',              hub:'healthcare',    emoji:'💊' },
    { id:'dental',           label:'Dental Clinic',                   hub:'healthcare',    emoji:'🦷' },
    { id:'optician',         label:'Optician / Eye Centre',           hub:'healthcare',    emoji:'👁️' },
    { id:'laboratory',       label:'Medical Laboratory / Radiology',  hub:'healthcare',    emoji:'🔬' },
    { id:'physiotherapy',    label:'Physiotherapy / Rehab Centre',    hub:'healthcare',    emoji:'🩺' },
    { id:'mental-health',    label:'Mental Health / Counselling',     hub:'healthcare',    emoji:'🧠' },
    { id:'vet',              label:'Veterinary Clinic / Pet Care',    hub:'healthcare',    emoji:'🐾' },
    /* Legal & Professional */
    { id:'lawyer',           label:'Lawyer / Advocate',               hub:'legal',         emoji:'⚖️' },
    { id:'accounting',       label:'Accountant / Auditor / CPA',      hub:'legal',         emoji:'📊' },
    { id:'tax-consultant',   label:'Tax Consultant / KRA Agent',      hub:'legal',         emoji:'📋' },
    { id:'notary',           label:'Notary / Commissioner for Oaths', hub:'legal',         emoji:'📜' },
    /* Entertainment */
    { id:'dj',               label:'DJ / Sound System',               hub:'entertainment', emoji:'🎧' },
    { id:'mc',               label:'MC / Host / Emcee',               hub:'entertainment', emoji:'🎤' },
    { id:'photographer',     label:'Photographer',                     hub:'entertainment', emoji:'📸' },
    { id:'videographer',     label:'Videographer / Film Crew',         hub:'entertainment', emoji:'🎬' },
    { id:'event-planner',    label:'Event Planner / Organiser',        hub:'entertainment', emoji:'🎉' },
    { id:'band',             label:'Live Band / Musician',             hub:'entertainment', emoji:'🎸' },
    { id:'comedian',         label:'Comedian / Stand-Up',              hub:'entertainment', emoji:'😂' },
    { id:'venue',            label:'Event Venue / Hall',               hub:'entertainment', emoji:'🏛️' },
    /* Automotive */
    { id:'mechanic',         label:'Auto Mechanic / Garage',           hub:'car',           emoji:'🔧' },
    { id:'car-wash',         label:'Car Wash / Auto Detailing',        hub:'car',           emoji:'🚗' },
    { id:'car-rental',       label:'Car Rental / Self-Drive',          hub:'car',           emoji:'🚙' },
    { id:'auto-parts',       label:'Auto Parts / Tyre Shop',           hub:'car',           emoji:'⚙️' },
    { id:'driving-school',   label:'Driving School',                   hub:'car',           emoji:'🎓' },
    { id:'insurance-auto',   label:'Car Insurance Agent',              hub:'car',           emoji:'🛡️' },
    /* 2026-10-03 Car Hub C3 — every Car Hub service gets its own application (category-specific questions below). */
    { id:'car-dealer',       label:'Car Dealer / Showroom',            hub:'car',           emoji:'🏪' },
    { id:'vehicle-inspection', label:'Vehicle Inspection Centre',      hub:'car',           emoji:'🔍' },
    { id:'towing-roadside',  label:'Towing / Roadside Assistance',     hub:'car',           emoji:'🆘' },
    { id:'fleet-operator',   label:'Fleet Operator',                   hub:'car',           emoji:'🚐' },
    { id:'vehicle-transport', label:'Vehicle Transport / Car Carrier', hub:'car',           emoji:'🚛' },
    { id:'vehicle-tracking', label:'Vehicle Tracking / GPS Installer', hub:'car',           emoji:'📡' },
    { id:'car-finance',      label:'Car Finance Partner (lender / broker)', hub:'car',      emoji:'💰' },
    { id:'ntsa-agent',       label:'NTSA / Vehicle Documents Agent',   hub:'car',           emoji:'🏛️' },
    /* Property */
    { id:'property-agent',   label:'Property Agent / Broker',          hub:'property',      emoji:'🏠' },
    { id:'developer',        label:'Property Developer',               hub:'property',      emoji:'🏗️' },
    { id:'landlord',         label:'Landlord / Long-Term Rental',      hub:'property',      emoji:'🔑' },
    { id:'bnb',              label:'BnB / Short-Stay Host',            hub:'bnb',           emoji:'🛎️' },
    { id:'hotel',            label:'Hotel / Guesthouse',               hub:'bnb',           emoji:'🏨' },
    /* Home Services */
    { id:'plumbing',         label:'Plumber',                          hub:'home-services', emoji:'🔧' },
    { id:'electrical',       label:'Electrician',                      hub:'home-services', emoji:'⚡' },
    { id:'cleaning',         label:'Cleaning Company / Housekeeping',  hub:'home-services', emoji:'🧹' },
    { id:'laundry',          label:'Laundry / Dry Cleaning',           hub:'home-services', emoji:'🧺' },
    { id:'painting',         label:'Painter / Decorator',              hub:'home-services', emoji:'🎨' },
    { id:'carpentry',        label:'Carpenter / Furniture Maker',      hub:'home-services', emoji:'🪚' },
    { id:'landscaping',      label:'Landscaper / Gardener',            hub:'home-services', emoji:'🌱' },
    { id:'pest-control',     label:'Pest Control',                     hub:'home-services', emoji:'🐛' },
    { id:'security-guard',   label:'Security Guard / Company',         hub:'home-services', emoji:'🛡️' },
    { id:'moving',           label:'Moving / Relocation Services',     hub:'home-services', emoji:'📦' },
    { id:'ac-repair',        label:'AC / Appliance Repair',            hub:'home-services', emoji:'❄️' },
    /* Technology */
    { id:'web-developer',    label:'Web Developer / Designer',         hub:'tech',          emoji:'💻' },
    { id:'app-developer',    label:'App Developer (iOS/Android)',      hub:'tech',          emoji:'📱' },
    { id:'it-support',       label:'IT Support',                       hub:'tech',          emoji:'🔌' },
    { id:'phone-repair',     label:'Phone & Tablet Repair',            hub:'tech',          emoji:'📱' },
    /* Tech Hub slice 4 (2026-10-03): each id is classified server-side (business-category → it_services) and maps to
       capabilities (shared/service-capabilities.js); the selection is a REQUEST — AdminOS approval grants them. */
    { id:'laptop-repair',    label:'Laptop Repair',                    hub:'tech',          emoji:'💻' },
    { id:'computer-repair',  label:'Computer / Desktop Repair',        hub:'tech',          emoji:'🖥️' },
    { id:'electronics-repair', label:'Electronics Repair (TV, audio, appliances)', hub:'tech', emoji:'📺' },
    { id:'networking',       label:'Networking / Wi-Fi Installation',  hub:'tech',          emoji:'📶' },
    { id:'pos-support',      label:'POS & Business Tech Support',      hub:'tech',          emoji:'🧾' },
    { id:'cctv',             label:'CCTV / Security Systems',          hub:'tech',          emoji:'📷' },
    { id:'software',         label:'Software / SaaS Company',          hub:'tech',          emoji:'💾' },
    { id:'data-entry',       label:'Data Entry / Virtual Assistant',   hub:'tech',          emoji:'📊' },
    /* Marketing & Media */
    { id:'graphic-design',   label:'Graphic Designer',                 hub:'marketing',     emoji:'🎨' },
    { id:'social-media',     label:'Social Media Manager',             hub:'marketing',     emoji:'📱' },
    { id:'printing',         label:'Printing / Branding / Signage',    hub:'marketing',     emoji:'🖨️' },
    { id:'advertising',      label:'Advertising Agency',               hub:'marketing',     emoji:'📢' },
    { id:'pr-firm',          label:'PR / Communications Firm',         hub:'marketing',     emoji:'📣' },
    { id:'content-creator',  label:'Content Creator / Influencer',     hub:'marketing',     emoji:'🎥' },
    /* Education */
    { id:'school',           label:'School / College / Training',      hub:'education',     emoji:'🏫' },
    { id:'tutor',            label:'Tutor / Private Teacher',          hub:'education',     emoji:'📚' },
    { id:'online-course',    label:'Online Course / E-Learning',       hub:'education',     emoji:'🖥️' },
    /* Beauty & Personal Care */
    { id:'salon',            label:'Hair Salon / Barbershop',          hub:'beauty',        emoji:'💇' },
    { id:'spa',              label:'Spa / Massage Therapy',            hub:'beauty',        emoji:'💆' },
    { id:'nail-art',         label:'Nail Art / Beauty Studio',         hub:'beauty',        emoji:'💅' },
    { id:'makeup',           label:'Makeup Artist / Bridal',           hub:'beauty',        emoji:'💄' },
    { id:'tatoo',            label:'Tattoo / Body Art Studio',         hub:'beauty',        emoji:'🖊️' },
    /* Fashion */
    { id:'tailor',           label:'Tailor / Fashion Designer',        hub:'fashion',       emoji:'🧵' },
    { id:'boutique',         label:'Boutique / Clothing Store',        hub:'fashion',       emoji:'👗' },
    { id:'shoe-repair',      label:'Shoe Repair / Cobbler',            hub:'fashion',       emoji:'👟' },
    /* Logistics */
    { id:'courier',          label:'Courier / Parcel Delivery',        hub:'delivery',      emoji:'🚚' },
    { id:'boda-delivery',    label:'Boda Boda Delivery',               hub:'delivery',      emoji:'🏍️' },
    /* Financial */
    { id:'insurance',        label:'Insurance Agent / Broker',         hub:'financial',     emoji:'🛡️' },
    { id:'sacco',            label:'SACCO / Microfinance / Chama',     hub:'financial',     emoji:'💰' },
    { id:'forex',            label:'Forex / Bureau de Change',         hub:'financial',     emoji:'💱' },
    /* Agriculture */
    { id:'farm',             label:'Farm / Fresh Produce Supplier',    hub:'agri',          emoji:'🌾' },
    { id:'dairy',            label:'Dairy / Poultry Farm',             hub:'agri',          emoji:'🐄' },
    { id:'agri-input',       label:'Agrovet / Farm Inputs',            hub:'agri',          emoji:'🌱' },
    /* Construction */
    { id:'contractor',       label:'Contractor / Builder',             hub:'construction',  emoji:'🏗️' },
    { id:'architect',        label:'Architect / Civil Engineer',       hub:'construction',  emoji:'📐' },
    /* B2B */
    { id:'manufacturer',     label:'Manufacturer / Factory',           hub:'b2b',           emoji:'🏭' },
    { id:'wholesaler',       label:'Wholesaler / Bulk Supplier',       hub:'b2b',           emoji:'📦' },
    { id:'importer',         label:'Importer / Exporter',              hub:'b2b',           emoji:'🌍' },
    /* Other */
    { id:'other',            label:'Other / General Business',         hub:'other',         emoji:'🏢' },
  ];

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ── Category-specific application questions (Car Hub C3, 2026-10-03) ─────────────────────────────────────
     Rendered under "Business Type" when a category with questions is chosen; saved as applications/{id}.details
     (strings only, length-capped) and shown to the reviewer in AdminOS. Licence numbers are declarations that AdminOS
     verifies — SOKONI does not issue NTSA results, insurance cover or loan approvals. */
  var Q = {
    services: function (opts) { return { id: 'services', label: 'Services you offer *', type: 'multi', options: opts, required: true }; },
    area:     { id: 'serviceArea', label: 'Service area (towns / counties) *', type: 'text', required: true, max: 160 },
    hours:    { id: 'hours', label: 'Operating hours *', type: 'select', options: ['24/7', 'Daytime only', 'Set hours (describe in description)'], required: true },
    mode:     { id: 'serviceMode', label: 'Where you work *', type: 'select', options: ['At my workshop / premises', 'I come to the customer (mobile)', 'Both'], required: true },
    years:    { id: 'yearsInBusiness', label: 'Years in business', type: 'number', max: 3 },
    regNo:    { id: 'businessRegNo', label: 'Business registration number (if registered)', type: 'text', max: 40 },
  };
  var CAT_QUESTIONS = {
    'mechanic': [Q.services(['General repair & servicing', 'Diagnostics (OBD)', 'Auto electrical', 'Body work & paint', 'Tyres & alignment', 'Gearbox / transmission', 'Air conditioning', 'Detailing']), Q.mode,
      { id: 'makes', label: 'Makes you specialise in', type: 'text', max: 120 }, Q.area, Q.years],
    'car-dealer': [{ id: 'dealerStock', label: 'What do you sell? *', type: 'select', options: ['Used vehicles', 'New vehicles', 'New and used'], required: true },
      { id: 'showroom', label: 'Showroom / yard location *', type: 'text', required: true, max: 160 },
      { id: 'stockSize', label: 'Approximate vehicles in stock', type: 'number', max: 5 }, Q.regNo, Q.years],
    'vehicle-inspection': [Q.services(['Pre-purchase inspection', 'Insurance / valuation inspection', 'Mechanical health check', 'Mobile inspection']), Q.mode,
      { id: 'accreditation', label: 'Accreditation / certifying body (AdminOS verifies)', type: 'text', max: 120 }, Q.area],
    'towing-roadside': [Q.services(['Towing', 'Recovery', 'Battery jump-start', 'Tyre change / puncture', 'Fuel delivery', 'Mechanical emergency']), Q.area, Q.hours,
      { id: 'towTrucks', label: 'Number of tow / recovery vehicles', type: 'number', max: 3 },
      { id: 'maxVehicle', label: 'Largest vehicle you can tow *', type: 'select', options: ['Saloon / SUV', 'Pickup / van', 'Minibus / light truck', 'Heavy commercial'], required: true }],
    'fleet-operator': [{ id: 'fleetSize', label: 'Fleet size (vehicles) *', type: 'number', required: true, max: 5 },
      Q.services(['Corporate hire', 'Staff transport', 'Logistics / deliveries', 'Tours & safari', 'Chauffeur services']),
      { id: 'vehicleTypes', label: 'Vehicle types', type: 'text', max: 120 }, Q.area, Q.regNo],
    'vehicle-transport': [{ id: 'carrierType', label: 'How you move vehicles *', type: 'select', options: ['Car carrier truck', 'Flatbed', 'Driven delivery (driver)', 'Several'], required: true },
      { id: 'maxPerTrip', label: 'Maximum vehicles per trip', type: 'number', max: 3 },
      { id: 'routes', label: 'Routes / coverage *', type: 'text', required: true, max: 160 }],
    'vehicle-tracking': [Q.services(['Device supply & installation', '24/7 monitoring', 'Fleet tracking', 'Anti-theft immobiliser']),
      { id: 'deviceBrands', label: 'Device brands you install', type: 'text', max: 120 }, Q.area],
    'car-finance': [{ id: 'institutionType', label: 'Institution type *', type: 'select', options: ['Bank', 'SACCO', 'Microfinance institution', 'Asset finance company', 'Broker / agent'], required: true },
      { id: 'licenceNo', label: 'Regulator licence number (AdminOS verifies) *', type: 'text', required: true, max: 60 },
      Q.services(['New vehicle loans', 'Used vehicle loans', 'Logbook loans', 'Asset finance for fleets'])],
    'insurance-auto': [{ id: 'intermediaryType', label: 'You are a *', type: 'select', options: ['Insurance agent', 'Insurance broker', 'Insurance company'], required: true },
      { id: 'licenceNo', label: 'IRA licence number (AdminOS verifies) *', type: 'text', required: true, max: 60 },
      { id: 'insurers', label: 'Insurers you represent', type: 'text', max: 160 }],
    'ntsa-agent': [Q.services(['Logbook transfer assistance', 'Logbook / registration documents', 'Driving licence renewal assistance', 'Vehicle search (official)']),
      { id: 'agentNote', label: 'How you work (customers visit / you visit / online)', type: 'text', max: 160 }, Q.area],
    'car-rental': [{ id: 'fleetSize', label: 'Vehicles available to rent *', type: 'number', required: true, max: 4 },
      { id: 'rentalMode', label: 'Rental type *', type: 'select', options: ['Self-drive', 'With driver', 'Both'], required: true }, Q.area],
    'car-wash': [Q.services(['Exterior wash', 'Interior cleaning', 'Full detailing', 'Engine wash', 'Mobile car wash']), Q.mode, Q.area],
    'auto-parts': [Q.services(['New parts', 'Used parts', 'Tyres', 'Batteries', 'Accessories']), { id: 'makes', label: 'Makes you stock for', type: 'text', max: 120 }],
    'electronics': [{ id: 'kraPin', label: 'KRA PIN (optional — AdminOS verifies)', type: 'text', max: 20 },
      { id: 'businessPermit', label: 'Business permit number (optional)', type: 'text', max: 40 },
      { id: 'sells', label: 'What you sell', type: 'multi', options: ['Phones', 'Laptops & computers', 'Tablets', 'Accessories', 'TVs & audio', 'Other electronics'] }],
    'driving-school': [{ id: 'licenceNo', label: 'NTSA driving school licence number (AdminOS verifies) *', type: 'text', required: true, max: 60 },
      Q.services(['Class B (car)', 'Class A (motorcycle)', 'Class C/D (commercial)', 'Refresher lessons']), Q.area],
  };
  function _qId(q, i) { return 'sreg_q_' + q.id + (i == null ? '' : '_' + i); }
  function _renderQuestions(cat) {
    var box = document.getElementById('sreg_details'); if (!box) return;
    var qs = CAT_QUESTIONS[cat] || [];
    if (!qs.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div style="margin-top:6px;padding:12px 14px;border:1px solid rgba(113,255,0,0.15);border-radius:14px;background:rgba(113,255,0,0.03);">'
      + '<div style="font-size:12px;color:rgba(255,255,255,0.55);">A few questions for this business type. SOKONI checks what you declare before approving.</div>'
      + qs.map(function (q) {
        var lab = '<label class="sreg-label">' + _esc(q.label) + '</label>';
        if (q.type === 'select') return lab + '<select id="' + _qId(q) + '" class="sreg-input"><option value="">— Select —</option>' + q.options.map(function (o) { return '<option>' + _esc(o) + '</option>'; }).join('') + '</select>';
        if (q.type === 'multi') return lab + '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + q.options.map(function (o, i) { return '<label style="display:inline-flex;align-items:center;gap:6px;padding:7px 10px;border:1px solid rgba(255,255,255,0.12);border-radius:10px;font-size:12px;color:#ddd;cursor:pointer;"><input type="checkbox" id="' + _qId(q, i) + '" value="' + _esc(o) + '"> ' + _esc(o) + '</label>'; }).join('') + '</div>';
        return lab + '<input id="' + _qId(q) + '" class="sreg-input"' + (q.type === 'number' ? ' type="number" min="0" inputmode="numeric"' : '') + ' maxlength="' + (q.max || 120) + '">';
      }).join('') + '</div>';
  }
  /* → { ok, details, error }. Strings only, length-capped; a number stays a digit string. */
  function _collectDetails(cat) {
    var qs = CAT_QUESTIONS[cat] || [], out = {};
    for (var k = 0; k < qs.length; k++) {
      var q = qs[k], v = '';
      if (q.type === 'multi') {
        var picked = []; for (var i = 0; i < q.options.length; i++) { var cb = document.getElementById(_qId(q, i)); if (cb && cb.checked) picked.push(q.options[i]); }
        v = picked.join(', ');
      } else {
        var el = document.getElementById(_qId(q)); v = el && el.value ? String(el.value).trim() : '';
        if (q.type === 'number') v = v.replace(/[^0-9]/g, '').slice(0, q.max || 5);
        else v = v.slice(0, q.max || 160);
      }
      if (q.required && !v) return { ok: false, error: 'Please answer: ' + q.label.replace(/\s*\*$/, '') };
      if (v) out[q.id] = v;
    }
    return { ok: true, details: out };
  }

  /* ── Inject styles once ───────────────────────────────────── */
  function _injectStyles() {
    if (document.getElementById('sokoniRegStyles')) return;
    var s = document.createElement('style');
    s.id = 'sokoniRegStyles';
    s.textContent = [
      '#sokoniRegOverlay{display:none;position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,0.88);backdrop-filter:blur(6px);}',
      '#sokoniRegOverlay.open{display:flex;align-items:center;justify-content:center;padding:16px;}',
      '#sokoniRegBox{background:#111;border:1px solid rgba(113,255,0,0.2);border-radius:24px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto;padding:28px 24px 24px;position:relative;scrollbar-width:thin;}',
      '#sokoniRegBox::-webkit-scrollbar{width:4px;}',
      '#sokoniRegBox::-webkit-scrollbar-track{background:transparent;}',
      '#sokoniRegBox::-webkit-scrollbar-thumb{background:rgba(113,255,0,0.2);border-radius:4px;}',
      '.sreg-title{font-size:18px;font-weight:900;color:white;margin-bottom:4px;}',
      '.sreg-sub{font-size:12px;color:rgba(255,255,255,0.4);margin-bottom:20px;}',
      '.sreg-label{display:block;font-size:11px;font-weight:800;color:rgba(113,255,0,0.7);letter-spacing:.06em;margin:14px 0 5px;text-transform:uppercase;}',
      '.sreg-input{width:100%;box-sizing:border-box;padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:white;font-size:16px;font-family:inherit;outline:none;transition:border-color .2s;}',
      '.sreg-input:focus{border-color:rgba(113,255,0,0.5);}',
      '.sreg-input option{background:#111;color:white;}',
      '.sreg-btn{width:100%;padding:14px;background:linear-gradient(135deg,#39ff14,#71ff00);border:none;border-radius:14px;color:#060b06;font-size:14px;font-weight:900;cursor:pointer;margin-top:20px;font-family:inherit;letter-spacing:.03em;}',
      '.sreg-btn:disabled{opacity:.5;cursor:not-allowed;}',
      '.sreg-close{position:absolute;top:18px;right:20px;background:none;border:none;color:rgba(255,255,255,0.4);font-size:20px;cursor:pointer;line-height:1;padding:4px 8px;}',
      '.sreg-msg{font-size:12px;margin-top:10px;min-height:16px;}',
      '.sreg-success{text-align:center;padding:20px 0;}',
      '.sreg-success .sreg-big{font-size:48px;margin-bottom:12px;}',
      '.sreg-success h3{font-size:18px;font-weight:900;color:white;margin:0 0 8px;}',
      '.sreg-success p{font-size:13px;color:rgba(255,255,255,0.5);margin:0 0 20px;}',
      '.sreg-success a{display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#39ff14,#71ff00);color:#060b06;font-weight:900;font-size:13px;border-radius:12px;text-decoration:none;margin:4px;}',
      '.sreg-success .sreg-sec{background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.1);}',
      '.sreg-plans{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px;}',
      '.sreg-plan{padding:14px;background:rgba(255,255,255,0.03);border:2px solid rgba(255,255,255,0.08);border-radius:14px;cursor:pointer;text-align:center;transition:border-color .2s;}',
      '.sreg-plan.sel{border-color:rgba(113,255,0,0.6);background:rgba(113,255,0,0.06);}',
      '.sreg-plan-name{font-size:13px;font-weight:800;color:white;margin-bottom:4px;}',
      '.sreg-plan-price{font-size:11px;color:rgba(255,255,255,0.45);}',
      '@media(max-width:480px){.sreg-plans{grid-template-columns:1fr;}}',
    ].join('');
    document.head.appendChild(s);
  }

  /* ── Build modal DOM ──────────────────────────────────────── */
  function _injectModal() {
    if (document.getElementById('sokoniRegOverlay')) return;
    var ov = document.createElement('div');
    ov.id = 'sokoniRegOverlay';
    ov.innerHTML =
      '<div id="sokoniRegBox">' +
        '<button class="sreg-close" onclick="HubRegister.close()">✕</button>' +
        '<div id="sokoniRegInner"></div>' +
      '</div>';
    ov.addEventListener('click', function (e) {
      if (e.target === ov) HubRegister.close();
    });
    document.body.appendChild(ov);
  }

  /* ── Build category <select> ─────────────────────────────── */
  function _catOptions(selectedId) {
    var html = '<option value="">— Select your business type —</option>';
    CATS.forEach(function (c) {
      var sel = c.id === selectedId ? ' selected' : '';
      html += '<option value="' + _esc(c.id) + '"' + sel + '>' + c.emoji + ' ' + _esc(c.label) + '</option>';
    });
    return html;
  }

  /* ── Render main registration form ──────────────────────── */
  function _renderForm(cfg) {
    cfg = cfg || {};
    var preCategory = cfg.category || '';
    document.getElementById('sokoniRegInner').innerHTML =
      '<div class="sreg-title">🏢 Register Your Business</div>' +
      '<div class="sreg-sub">Join SOKONI — reach thousands of customers across Kenya</div>' +

      '<label class="sreg-label">Business / Provider Name *</label>' +
      '<input id="sreg_name" class="sreg-input" placeholder="e.g. Nairobi Quick Cleaners" autocomplete="organization">' +

      '<label class="sreg-label">Business Type *</label>' +
      '<select id="sreg_cat" class="sreg-input" onchange="HubRegister._renderQuestions(this.value)">' + _catOptions(preCategory) + '</select>' +
      '<div id="sreg_details"></div>' +

      '<label class="sreg-label">Phone Number *</label>' +
      '<input id="sreg_phone" class="sreg-input" type="tel" placeholder="07XX XXX XXX" inputmode="tel">' +

      '<label class="sreg-label">Email Address</label>' +
      '<input id="sreg_email" class="sreg-input" type="email" placeholder="business@example.com" inputmode="email">' +

      '<label class="sreg-label">Location / Area *</label>' +
      '<input id="sreg_loc" class="sreg-input" placeholder="e.g. Westlands, Nairobi">' +

      '<label class="sreg-label">Brief Description *</label>' +
      '<textarea id="sreg_desc" class="sreg-input" rows="3" placeholder="What services do you offer? Opening hours, specialities…" style="resize:vertical;"></textarea>' +

      '<label class="sreg-label">Listing Plan</label>' +
      '<div class="sreg-plans">' +
        '<div class="sreg-plan sel" id="sreg_plan_free" onclick="HubRegister._selectPlan(\'free\')">' +
          '<div class="sreg-plan-name">Free</div>' +
          '<div class="sreg-plan-price">KES 0 — basic listing<br>pending review</div>' +
        '</div>' +
        '<div class="sreg-plan" id="sreg_plan_starter" onclick="HubRegister._selectPlan(\'starter\')">' +
          '<div class="sreg-plan-name">⚡ Starter</div>' +
          '<div class="sreg-plan-price">KES 500/mo — verified badge<br>+ priority placement</div>' +
        '</div>' +
        '<div class="sreg-plan" id="sreg_plan_pro" onclick="HubRegister._selectPlan(\'pro\')">' +
          '<div class="sreg-plan-name">🚀 Pro</div>' +
          '<div class="sreg-plan-price">KES 2,000/mo — unlimited leads<br>+ analytics dashboard</div>' +
        '</div>' +
        '<div class="sreg-plan" id="sreg_plan_enterprise" onclick="HubRegister._selectPlan(\'enterprise\')">' +
          '<div class="sreg-plan-name">👑 Enterprise</div>' +
          '<div class="sreg-plan-price">KES 5,000/mo — all features<br>+ dedicated support</div>' +
        '</div>' +
      '</div>' +

      '<button class="sreg-btn" onclick="HubRegister._submit()">✅ Register My Business</button>' +
      '<div id="sreg_msg" class="sreg-msg"></div>';

    window._sokoniRegPlan = 'free';
    if (preCategory) _renderQuestions(preCategory);
  }

  /* ── Plan selector ───────────────────────────────────────── */
  function _selectPlan(plan) {
    ['free','starter','pro','enterprise'].forEach(function (p) {
      var el = document.getElementById('sreg_plan_' + p);
      if (el) el.classList.toggle('sel', p === plan);
    });
    window._sokoniRegPlan = plan;
  }

  /* ── Validate Kenyan phone ───────────────────────────────── */
  function _validPhone(p) {
    return /^(07|01)[0-9]{8}$/.test(p.replace(/[\s\-]/g, ''));
  }

  /* ── Save to Firestore via v9 dynamic import ─────────────────────────────
     This used to swallow every failure into a console.warn and resolve anyway,
     so `_submit` went on to render "<Business> is now on SOKONI!" over an
     application that had never been written. The rejection now propagates —
     the caller decides what the operator is told, and it is never "you're
     registered" when nothing was saved. */
  function _saveToFirestore(data) {
    if (!window.firebaseDB) {
      return Promise.reject(new Error('Database unavailable — check your connection.'));
    }
    return import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
      .then(function (fs) {
        return fs.addDoc(fs.collection(window.firebaseDB, 'applications'), data);
      });
  }

  /* ── Show success screen ─────────────────────────────────── */
  function _showSuccess(data, applicationId) {
    var planLabels = { free:'Free', starter:'Starter', pro:'Pro', enterprise:'Enterprise' };
    var planLabel = planLabels[data.plan] || 'Free';
    /* The truthful next step. Writing the application is ALL that happened here: nothing
       is approved or live until SOKONI decides it in AdminOS (applicationDecide). The
       applicant follows it on complete-application.html, which asks the ONE workspace
       authority (providerDispatch {op:'businessWorkspace'}) and shows pending / decided /
       "Open your workspace" with the server-named route. This used to link
       provider.html?cat=<id> — a second intake — and announce "is now on SOKONI!". */
    var trackLink = 'complete-application.html';
    var subsLink = 'subscriptions.html';

    document.getElementById('sokoniRegInner').innerHTML =
      '<div class="sreg-success">' +
        '<div class="sreg-big">📨</div>' +
        '<h3>Application submitted — SOKONI reviews it in AdminOS</h3>' +
        '<p>' + _esc(data.name) + ' (' + _esc(planLabel) + ' plan) is with SOKONI for review.<br>' +
        'You will be notified when it is decided. Your business dashboard opens after SOKONI approves it.' +
        '</p>' +
        '<a href="' + trackLink + '">📋 Track my application</a>' +
        (data.plan === 'free'
          ? '<br><a href="' + subsLink + '" class="sreg-sec" style="margin-top:8px;">⚡ Upgrade to Paid Plan</a>'
          : '') +
        '<br><button onclick="HubRegister.close()" style="margin-top:14px;background:none;border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.4);border-radius:10px;padding:8px 20px;cursor:pointer;font-family:inherit;font-size:12px;">Close</button>' +
      '</div>';

    /* If paid plan, hand off to SokoniPay through a SERVER-MINTED intent.
       The amount used to be a client table { starter:500, pro:2000, enterprise:5000 }
       passed straight to the gateway — the browser set the price (and, because
       showGateway reads depositAmount not `amount`, that figure was silently
       ignored and a default deposit charged). createPaymentIntent now derives the
       price server-side from the application's plan (payment-purposes
       hub_registration: applications/{id}.plan → hubPlans, else the documented
       default), and initiateSTKPush enforces that figure against the minted
       intent — a tampered client cannot pay less. */
    if (data.plan !== 'free' && applicationId && window.SokoniPay && typeof window.sokoniCallable === 'function') {
      setTimeout(function () {
        (async function () {
          var _warn = window._skToast || function (m) { if (window.SokoniLogger) window.SokoniLogger.warn(m); };
          var _intent;
          try {
            var _r = await window.sokoniCallable('createPaymentIntent')({ purpose: 'hub_registration', applicationId: applicationId });
            _intent = _r && _r.data;
          } catch (e) {
            _warn('Could not start payment: ' + ((e && e.message) || 'please try again.'));
            return;
          }
          if (!_intent || !_intent.ref) { _warn('Could not start payment. Please try again.'); return; }
          SokoniPay.gateway({
            title: 'SOKONI ' + planLabel + ' Plan — ' + data.name,
            /* server figure + server reference — never a client price */
            depositAmount:   _intent.amount,
            paymentIntentId: _intent.ref,
            ref:             _intent.ref,
            onSuccess: function () {
              /* Post-settlement cache only (gateway onSuccess fires after the
                 webhook confirms payment). Not a grant and not a price source. */
              try {
                localStorage.setItem('sokoniSubscription', JSON.stringify({
                  plan: data.plan, price: _intent.amount, ref: _intent.ref,
                  startDate: new Date().toISOString()
                }));
              } catch (e) {}
            }
          });
        })();
      }, 600);
    }
  }

  /* ── Submit ──────────────────────────────────────────────── */
  function _submit() {
    var name  = (document.getElementById('sreg_name')?.value  || '').trim();
    var cat   = (document.getElementById('sreg_cat')?.value   || '').trim();
    var phone = (document.getElementById('sreg_phone')?.value || '').trim();
    var email = (document.getElementById('sreg_email')?.value || '').trim();
    var loc   = (document.getElementById('sreg_loc')?.value   || '').trim();
    var desc  = (document.getElementById('sreg_desc')?.value  || '').trim();
    var plan  = window._sokoniRegPlan || 'free';
    var msgEl = document.getElementById('sreg_msg');

    function _err(m) {
      if (msgEl) { msgEl.textContent = '⚠️ ' + m; msgEl.style.color = '#f97316'; }
    }

    if (!name)  { _err('Enter your business name.'); return; }
    if (!cat)   { _err('Select your business type.'); return; }
    if (!phone) { _err('Enter your phone number.'); return; }
    if (!_validPhone(phone)) { _err('Enter a valid Kenyan phone (07XX or 01XX).'); return; }
    if (!loc)   { _err('Enter your location.'); return; }
    if (!desc)  { _err('Add a brief description.'); return; }
    var _det = _collectDetails(cat);
    if (!_det.ok) { _err(_det.error); return; }

    if (msgEl) { msgEl.textContent = 'Saving…'; msgEl.style.color = 'rgba(255,255,255,0.4)'; }

    var catObj = CATS.find(function (c) { return c.id === cat; }) || { label: cat, emoji: '🏢', hub: 'other' };
    var user = null;
    try { user = JSON.parse(localStorage.getItem('sokoniUser') || 'null'); } catch (e) {}

    /* Only the Auth session counts. A uid read out of localStorage cannot be
       trusted by firestore.rules (the create rule requires
       request.resource.data.uid == request.auth.uid), so a cached value produced
       an application that was either rejected outright or — worse — written with
       a uid the server would never match, leaving an approved business with no
       account to grant the role to. Sign-in is now a precondition, stated plainly
       instead of failing later. */
    var uid = (window.firebaseAuth && window.firebaseAuth.currentUser)
      ? window.firebaseAuth.currentUser.uid
      : null;

    if (!uid) {
      _err('Please sign in first — we link your listing to your account so you can manage it.');
      setTimeout(function () {
        window.location.href = 'login.html?next=' + encodeURIComponent(location.pathname + location.search);
      }, 1400);
      return;
    }

    /* Contact number in BOTH shapes. `phone` is the local form the dashboards
       render and WhatsApp links use; `phoneNumber` is the E.164 form every SMS
       path and _findUserByPhone key on. Storing only one made the applicant
       un-messageable by whichever path wanted the other. */
    var digits = phone.replace(/\D/g, '');
    var e164 = /^0[17]\d{8}$/.test(digits) ? '+254' + digits.slice(1) : null;

    /* ── Declared role (Roles Phase 1) ──────────────────────────────────────
       This surface knows more than any keyword matcher can recover: the operator
       picked one of 103 categories by id, and the id says exactly what they are.
       Before this, `category`, `categoryLabel` and `hub` were pooled into free
       text server-side and pattern-matched — so "Auto Mechanic / Garage" matched
       the word `mechanic` INSIDE the provider pattern and every garage on the
       platform became a generic provider, and "Landlord / Long-Term Rental"
       matched nothing at all and fell through to provider by default.
       The choice is mapped here, at the surface that owns it. Specific category
       ids win; then the hub; then provider, which is what an unmapped service
       category genuinely is. */
    /* 2026-10-03 Car Hub C3: a mechanic / garage is a bookable SERVICE PROVIDER (providers/{uid} + business category stamp →
       booking engine, IntaSend, booking PIN, 5% at settlement, provider dashboard) — like every Home Services and Tech
       category. The old 'mechanic' role projected only mechanics/{uid}: listed, never bookable, no dashboard. Existing
       mechanics/{uid} profiles stay readable (mechanics.html merges both registries). */
    var _ROLE_BY_CATEGORY = { landlord: 'landlord' };
    var _ROLE_BY_HUB = { delivery: 'rider', healthcare: 'health', legal: 'legal', shopping: 'seller' };
    var _requestedRole = _ROLE_BY_CATEGORY[cat] || _ROLE_BY_HUB[catObj.hub] || 'provider';

    var data = {
      id:          'APP' + Date.now(),
      name:        name,
      category:    cat,
      categoryLabel: catObj.label,
      hub:         catObj.hub,
      requestedRole: _requestedRole,
      phone:       phone,
      phoneNumber: e164,
      email:       email || (user && user.email ? user.email : ''),
      location:    loc,
      description: desc,
      details:     _det.details,
      plan:        plan,
      status:      'pending',
      type:        'business',
      uid:         uid,
      submittedAt: new Date().toISOString(),
      createdAt:   Date.now()
    };

    /* localStorage backup */
    try {
      var apps = JSON.parse(localStorage.getItem('sokoniPendingApplications') || '[]');
      apps.unshift(data);
      localStorage.setItem('sokoniPendingApplications', JSON.stringify(apps.slice(0, 50)));
    } catch (e) {}

    /* Provider profile so provider.html knows who you are */
    try {
      var pvProfile = {
        id: 'PRV' + Date.now().toString(36).toUpperCase(),
        cat: catObj.hub || cat, name: name, phone: phone,
        email: data.email, location: loc, bio: desc, status: 'pending',
        createdAt: Date.now()
      };
      localStorage.setItem('sokoniProviderProfile', JSON.stringify(pvProfile));
    } catch (e) {}

    /* Firestore is the gate, not a nice-to-have.
       The old version called _showSuccess() from BOTH branches — "still succeed
       locally" — so a rejected write still told the operator their business was
       on SOKONI. It was on nothing: the localStorage copy above is visible only
       in that one browser and reaches no reviewer. Success is now reported only
       when the application actually exists server-side. */
    _saveToFirestore(data).then(function (appRef) {
      /* addDoc returns the DocumentReference. Its id is the authoritative
         applicationId the server prices the paid plan against — see _showSuccess. */
      _showSuccess(data, appRef && appRef.id);
    }).catch(function (e) {
      console.error('[HubRegister] save failed', e);
      _err('We could not submit your registration: ' +
           ((e && e.message) ? e.message : 'unknown error') +
           ' — please check your connection and tap Register again.');
    });
  }

  /* ── Public API ──────────────────────────────────────────── */
  window.HubRegister = {
    open: function (cfg) {
      _injectStyles();
      _injectModal();
      _renderForm(cfg || {});
      document.getElementById('sokoniRegOverlay').classList.add('open');
      document.body.style.overflow = 'hidden';
    },
    close: function () {
      var ov = document.getElementById('sokoniRegOverlay');
      if (ov) ov.classList.remove('open');
      document.body.style.overflow = '';
    },
    /* Read-only lookup of ONE category (a copy), so an entry page can pass the id's hub
       without restating this list. Unknown id → null. */
    category: function (id) {
      var c = CATS.filter(function (x) { return x.id === id; })[0];
      return c ? { id: c.id, label: c.label, hub: c.hub, emoji: c.emoji } : null;
    },
    _selectPlan: _selectPlan,
    _renderQuestions: _renderQuestions,
    _submit:     _submit
  };

  /* Escape key to close */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') HubRegister.close();
  });

})();
