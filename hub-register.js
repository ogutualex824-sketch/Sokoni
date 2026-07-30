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
    { id:'hardware',         label:'Hardware / Building Materials',    hub:'construction',  emoji:'🧱' },
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
    { id:'it-support',       label:'IT Support / Networking',          hub:'tech',          emoji:'🔌' },
    { id:'phone-repair',     label:'Phone Repair / Electronics',       hub:'tech',          emoji:'📱' },
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
      '<select id="sreg_cat" class="sreg-input">' + _catOptions(preCategory) + '</select>' +

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
  function _showSuccess(data) {
    var planLabels = { free:'Free', starter:'Starter', pro:'Pro', enterprise:'Enterprise' };
    var planLabel = planLabels[data.plan] || 'Free';
    var pvLink = 'provider.html?cat=' + encodeURIComponent(data.category || 'other');
    var subsLink = 'subscriptions.html';

    document.getElementById('sokoniRegInner').innerHTML =
      '<div class="sreg-success">' +
        '<div class="sreg-big">🎉</div>' +
        '<h3>' + _esc(data.name) + ' is now on SOKONI!</h3>' +
        '<p>Your ' + _esc(planLabel) + ' listing has been submitted.<br>' +
        (data.plan === 'free'
          ? 'We\'ll review and activate your listing within 24 hours.'
          : 'Your paid listing is live immediately!') +
        '</p>' +
        '<a href="' + pvLink + '">📋 Go to Provider Dashboard</a>' +
        (data.plan === 'free'
          ? '<br><a href="' + subsLink + '" class="sreg-sec" style="margin-top:8px;">⚡ Upgrade to Paid Plan</a>'
          : '') +
        '<br><button onclick="HubRegister.close()" style="margin-top:14px;background:none;border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.4);border-radius:10px;padding:8px 20px;cursor:pointer;font-family:inherit;font-size:12px;">Close</button>' +
      '</div>';

    /* If paid plan, hand off to SokoniPay */
    var prices = { starter: 500, pro: 2000, enterprise: 5000 };
    if (data.plan !== 'free' && prices[data.plan] && window.SokoniPay) {
      setTimeout(function () {
        SokoniPay.gateway({
          title: 'SOKONI ' + planLabel + ' Plan — ' + data.name,
          amount: prices[data.plan],
          onSuccess: function () {
            try {
              localStorage.setItem('sokoniSubscription', JSON.stringify({
                plan: data.plan, price: prices[data.plan],
                startDate: new Date().toISOString()
              }));
            } catch (e) {}
          }
        });
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

    var data = {
      id:          'APP' + Date.now(),
      name:        name,
      category:    cat,
      categoryLabel: catObj.label,
      hub:         catObj.hub,
      phone:       phone,
      phoneNumber: e164,
      email:       email || (user && user.email ? user.email : ''),
      location:    loc,
      description: desc,
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
    _saveToFirestore(data).then(function () {
      _showSuccess(data);
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
    _selectPlan: _selectPlan,
    _submit:     _submit
  };

  /* Escape key to close */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') HubRegister.close();
  });

})();
