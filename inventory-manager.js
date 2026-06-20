/* ================================================================
   SOKONI Universal Inventory Manager  v1.0
   Works for any service type: pharmacy, food, cars, parts, etc.
   Usage:
     SokoniInventory.open({ preset:'pharmacy', ownerKey:'sokoniMyPharmacy' });
   Or auto-detect from provider profile:
     SokoniInventory.openForProvider();
================================================================ */
window.SokoniInventory = (function(){

  /* ── Per-business presets ── */
  const PRESETS = {
    pharmacy: {
      icon:'💊', label:'Medicine', pluralLabel:'Medicines', color:'#00c878',
      storageKey:'sokoniPharmacyInventory',
      categories:['Antibiotics','Antimalaria','Painkillers','Antifungal','Vitamins & Supplements','First Aid','Chronic Disease','Cosmetics','Baby Care','Vaccines','General'],
      units:['tablet','capsule','bottle','sachet','ampoule','vial','tube','pack','roll','syringe'],
      priceLabel:'Price (KES)', stockLabel:'Stock Qty',
      extraFields:[{ id:'requiresRx', type:'checkbox', label:'Requires Prescription (Rx)' }]
    },
    dispensary: {
      icon:'💉', label:'Medicine', pluralLabel:'Medicines', color:'#00c878',
      storageKey:'sokoniDispensaryInventory',
      categories:['Essential Medicines','Family Planning','Immunisation','Malaria','TB','HIV/ARVs','Maternal Health','Child Health','First Aid','General'],
      units:['tablet','capsule','bottle','sachet','ampoule','vial','tube','pack'],
      priceLabel:'Price (KES)', stockLabel:'Stock Qty',
      extraFields:[{ id:'requiresRx', type:'checkbox', label:'Requires Prescription (Rx)' }]
    },
    food: {
      icon:'🍽️', label:'Menu Item', pluralLabel:'Menu Items', color:'#ff9800',
      storageKey:'sokoniFoodInventory',
      categories:['Breakfast','Starters','Main Course','Grills','Rice & Ugali','Chapati & Bread','Sides & Salads','Soups & Stews','Desserts','Drinks & Juices','Specials'],
      units:['portion','plate','glass','bottle','bowl','piece','kg','half portion'],
      priceLabel:'Price (KES)', stockLabel:'Daily Portions Available',
      extraFields:[
        { id:'prepTime', type:'text', label:'Prep Time', ph:'e.g. 15 mins' },
        { id:'isVeg', type:'checkbox', label:'Vegetarian / Vegan' }
      ]
    },
    'car-rental': {
      icon:'🚗', label:'Vehicle', pluralLabel:'Vehicles', color:'#3b82f6',
      storageKey:'sokoniCarInventory',
      categories:['Economy','Sedan','SUV','4x4','Pickup','Minivan','Bus / Matatu','Luxury','Motorcycle','Tuk-Tuk'],
      units:['vehicle'],
      priceLabel:'Daily Rate (KES)', stockLabel:'Units Available',
      extraFields:[
        { id:'plate', type:'text', label:'Plate Number', ph:'e.g. KDG 123A' },
        { id:'seats', type:'number', label:'Seats', ph:'e.g. 5' },
        { id:'fuel', type:'text', label:'Fuel Type', ph:'e.g. Petrol, Diesel, Electric' },
        { id:'transmission', type:'text', label:'Transmission', ph:'e.g. Manual, Automatic' }
      ]
    },
    mechanic: {
      icon:'🔩', label:'Part / Service', pluralLabel:'Parts & Services', color:'#94a3b8',
      storageKey:'sokoniAutoPartsInventory',
      categories:['Engine Parts','Brakes & Discs','Tyres','Suspension','Electrical','Filters','Body Parts','Oils & Fluids','Batteries','Tools & Equipment','Labour Services'],
      units:['piece','set','litre','kg','pack','roll'],
      priceLabel:'Price (KES)', stockLabel:'Qty in Stock',
      extraFields:[
        { id:'compatibility', type:'text', label:'Compatible With', ph:'e.g. Toyota Fielder, Nissan X-Trail' },
        { id:'brand', type:'text', label:'Brand', ph:'e.g. Toyota Genuine, NGK, Bosch' }
      ]
    },
    construction: {
      icon:'🏗️', label:'Material', pluralLabel:'Materials', color:'#b45309',
      storageKey:'sokoniConstructionInventory',
      categories:['Cement & Concrete','Steel & Iron Bars','Timber & Wood','Sand & Ballast','Roofing Sheets','Tiles & Flooring','Plumbing Pipes','Electrical Cable','Paint & Varnish','Hardware & Fasteners','Safety Equipment'],
      units:['bag','tonne','piece','m²','m³','litre','roll','sheet','length','pair'],
      priceLabel:'Price (KES)', stockLabel:'Qty in Stock',
      extraFields:[
        { id:'brand', type:'text', label:'Brand / Supplier', ph:'e.g. Bamburi, Mabati, ARM' },
        { id:'spec', type:'text', label:'Specification', ph:'e.g. 32.5N, 3mm, 6m length' }
      ]
    },
    cleaning: {
      icon:'🧹', label:'Product', pluralLabel:'Products', color:'#22d3ee',
      storageKey:'sokoniCleaningInventory',
      categories:['Surface Cleaners','Disinfectants','Laundry','Kitchen Degreasers','Bathroom','Glass & Windows','Industrial Strength','Eco-Friendly','Protective Equipment','Equipment & Tools'],
      units:['litre','bottle','kg','sachet','piece','pack','drum','spray'],
      priceLabel:'Price (KES)', stockLabel:'Qty in Stock',
      extraFields:[{ id:'brand', type:'text', label:'Brand', ph:'e.g. Jik, Dettol, Mr. Muscle' }]
    },
    digital: {
      icon:'💻', label:'Digital Product', pluralLabel:'Digital Products', color:'#a855f7',
      storageKey:'sokoniDigitalInventory',
      categories:['eBooks & PDFs','Online Courses','Templates & Designs','Software & Apps','Music & Beats','Videos & Films','Photo Packs','Fonts & Icons','Plugins & Scripts','Other'],
      units:['license','download','subscription','access'],
      priceLabel:'Price (KES)', stockLabel:'Licenses (0 = unlimited)',
      extraFields:[
        { id:'format', type:'text', label:'Format / Platform', ph:'e.g. PDF, MP4, ZIP, SaaS' },
        { id:'downloadUrl', type:'text', label:'Download / Access Link', ph:'https://...' }
      ]
    },
    bnb: {
      icon:'🏠', label:'Room / Unit', pluralLabel:'Rooms & Units', color:'#ff6b35',
      storageKey:'sokoniBnbInventory',
      categories:['Standard Room','Deluxe Room','Suite','Studio Apartment','1 Bedroom','2 Bedroom','3 Bedroom','Full House','Penthouse','Camping / Tent'],
      units:['room','unit','bed','tent'],
      priceLabel:'Nightly Rate (KES)', stockLabel:'Units Available',
      extraFields:[
        { id:'capacity', type:'number', label:'Max Guests', ph:'e.g. 2' },
        { id:'amenities', type:'text', label:'Amenities', ph:'e.g. WiFi, Pool, Parking, AC, DSTV' }
      ]
    },
    landlord: {
      icon:'🏘️', label:'Property / Unit', pluralLabel:'Properties', color:'#16a34a',
      storageKey:'sokoniLandlordInventory',
      categories:['Bedsitter','1 Bedroom','2 Bedroom','3 Bedroom','4 Bedroom+','Studio','Maisonette','Commercial Space','Office','Warehouse'],
      units:['unit','floor','room'],
      priceLabel:'Monthly Rent (KES)', stockLabel:'Units Available',
      extraFields:[
        { id:'deposit', type:'number', label:'Deposit (KES)', ph:'e.g. 10000' },
        { id:'amenities', type:'text', label:'Amenities', ph:'e.g. Water, Security, Parking' },
        { id:'furnished', type:'checkbox', label:'Furnished' }
      ]
    },
    healthcare: {
      icon:'🏥', label:'Service / Equipment', pluralLabel:'Services', color:'#00c878',
      storageKey:'sokoniHcInventory',
      categories:['Consultations','Lab Tests','Procedures','Equipment Rental','Home Visits','Vaccinations','Specialist Referrals','Mental Health','Physiotherapy'],
      units:['session','test','procedure','hour','day'],
      priceLabel:'Fee (KES)', stockLabel:'Slots Available',
      extraFields:[{ id:'duration', type:'text', label:'Duration', ph:'e.g. 30 mins, 1 hour' }]
    },
    hardware: {
      icon:'🔨', label:'Item', pluralLabel:'Items', color:'#f59e0b',
      storageKey:'sokoniHardwareInventory',
      categories:['Hand Tools','Power Tools','Nails & Fasteners','Plumbing','Electrical','Paint & Brushes','Safety Gear','Ladders','Storage','Garden & Outdoor'],
      units:['piece','set','box','pack','roll','litre','kg','m','pair'],
      priceLabel:'Price (KES)', stockLabel:'Qty in Stock',
      extraFields:[{ id:'brand', type:'text', label:'Brand', ph:'e.g. Stanley, Bosch, Makita' }]
    },
    fitness: {
      icon:'🏋️', label:'Session / Package', pluralLabel:'Sessions & Packages', color:'#ef4444',
      storageKey:'sokoniFitnessInventory',
      categories:['Personal Training','Group Class','Online Coaching','Monthly Package','Nutrition Plan','Yoga','CrossFit','Boxing','Dance','Kids Fitness'],
      units:['session','class','month','week','package'],
      priceLabel:'Price (KES)', stockLabel:'Slots Available',
      extraFields:[
        { id:'duration', type:'text', label:'Duration', ph:'e.g. 1 hour' },
        { id:'maxClients', type:'number', label:'Max Clients per Session', ph:'e.g. 10' }
      ]
    },
    catering: {
      icon:'🍲', label:'Menu Item', pluralLabel:'Menu Items', color:'#ea580c',
      storageKey:'sokoniCateringInventory',
      categories:['Breakfast','Lunch Boxes','Buffet','Dinner','Snacks','Beverages','Cakes & Pastries','Corporate Packages','Wedding Packages','Special Events'],
      units:['portion','serving','piece','tray','kg','litre','box'],
      priceLabel:'Price per Unit (KES)', stockLabel:'Available Qty',
      extraFields:[
        { id:'minOrder', type:'number', label:'Min. Order Qty', ph:'e.g. 10' },
        { id:'isVeg', type:'checkbox', label:'Vegetarian / Halal option' }
      ]
    },
    general: {
      icon:'📦', label:'Item', pluralLabel:'Items', color:'#71ff00',
      storageKey:'sokoniGeneralInventory',
      categories:['Category A','Category B','Category C','Category D','Other'],
      units:['piece','unit','kg','litre','pack','box','set'],
      priceLabel:'Price (KES)', stockLabel:'Qty in Stock',
      extraFields:[]
    }
  };

  /* ── State ── */
  let _preset = null;
  let _cfg = null;
  let _items = [];
  let _ownerKey = null;
  let _modalId = 'sokoniInvManagerModal';
  let _editId = null;

  /* ── Load / Save ── */
  function _load(){ try{ _items=JSON.parse(localStorage.getItem(_cfg.storageKey)||'[]'); }catch(e){ _items=[]; } }
  function _save(){ localStorage.setItem(_cfg.storageKey, JSON.stringify(_items)); }

  /* ── Detect preset from provider profile ── */
  function _detectPreset(){
    try{
      const p = JSON.parse(localStorage.getItem('sokoniProviderProfile')||'null');
      if(!p) return 'general';
      const cat = p.cat||'';
      const map = {
        'pharmacy':'pharmacy','dispensary':'dispensary',
        'food':'food','catering':'catering',
        'car-rental':'car-rental','ride':'car-rental',
        'mechanic':'mechanic',
        'construction':'construction',
        'cleaning':'cleaning',
        'digital':'digital',
        'bnb':'bnb','landlord':'landlord',
        'healthcare':'healthcare',
        'fitness':'fitness','sports':'fitness',
        'hardware':'hardware',
      };
      return map[cat] || 'general';
    }catch(e){ return 'general'; }
  }

  /* ── Build modal HTML ── */
  function _buildModal(){
    if(document.getElementById(_modalId)) return;
    const c = _cfg;
    const extraInputs = (c.extraFields||[]).map(f=>{
      if(f.type==='checkbox') return `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
          <input type="checkbox" id="simExt_${f.id}" style="accent-color:${c.color};width:16px;height:16px;">
          <label for="simExt_${f.id}" style="font-size:13px;color:rgba(255,255,255,0.6);">${f.label}</label>
        </div>`;
      return `
        <div style="margin-bottom:10px;">
          <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">${f.label}</div>
          <input type="${f.type||'text'}" id="simExt_${f.id}" placeholder="${f.ph||''}" style="width:100%;padding:10px 13px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;font-family:inherit;">
        </div>`;
    }).join('');

    const unitOptions = (c.units||['piece']).map(u=>`<option value="${u}">${u.charAt(0).toUpperCase()+u.slice(1)}</option>`).join('');
    const catOptions  = (c.categories||[]).map(cat=>`<option value="${cat}">${cat}</option>`).join('');

    const div = document.createElement('div');
    div.id = _modalId;
    div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);backdrop-filter:blur(10px);z-index:9000;display:none;align-items:flex-start;justify-content:center;overflow-y:auto;padding:0;';
    div.onclick = function(e){ if(e.target===this) SokoniInventory.close(); };
    div.innerHTML = `
      <div style="background:#101010;border:1px solid ${c.color}33;border-radius:0 0 24px 24px;width:100%;max-width:720px;min-height:100vh;">
        <!-- Sticky header -->
        <div id="simHeader" style="position:sticky;top:0;background:#101010;border-bottom:1px solid rgba(255,255,255,0.07);padding:16px 22px;display:flex;align-items:center;justify-content:space-between;z-index:10;gap:12px;flex-wrap:wrap;">
          <div>
            <div id="simTitle" style="font-size:17px;font-weight:900;color:white;"></div>
            <div id="simStats" style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:2px;"></div>
          </div>
          <button onclick="SokoniInventory.close()" style="padding:8px 16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.6);border-radius:9px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:700;">✕ Close</button>
        </div>

        <div style="padding:20px 22px 50px;">
          <!-- Search + filter -->
          <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
            <input type="text" id="simSearch" placeholder="🔍 Search ${c.pluralLabel||c.label+'s'}…" oninput="SokoniInventory._render()" style="flex:1;min-width:160px;padding:10px 14px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;font-family:inherit;">
            <select id="simFilter" onchange="SokoniInventory._render()" style="padding:10px 12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;font-family:inherit;cursor:pointer;">
              <option value="">All ${c.pluralLabel||c.label+'s'}</option>
              <option value="available">Available</option>
              <option value="unavailable">Unavailable / Out</option>
            </select>
          </div>

          <!-- List -->
          <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;">${c.pluralLabel||c.label+'s'}</div>
          <div id="simList"></div>

          <!-- Add / Edit form -->
          <div id="simForm" style="background:rgba(255,255,255,0.02);border:1px solid ${c.color}33;border-radius:16px;padding:20px;margin-top:20px;">
            <div style="font-size:14px;font-weight:800;color:${c.color};margin-bottom:14px;" id="simFormTitle">➕ Add ${c.label}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
              <div style="grid-column:1/-1;">
                <input type="text" id="simName" placeholder="${c.label} name *" style="width:100%;padding:11px 13px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;font-family:inherit;">
              </div>
              <div>
                <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px;font-weight:700;text-transform:uppercase;">Category</div>
                <select id="simCategory" style="width:100%;padding:11px 13px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;font-family:inherit;cursor:pointer;">
                  ${catOptions}
                </select>
              </div>
              <div>
                <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px;font-weight:700;text-transform:uppercase;">Unit</div>
                <select id="simUnit" style="width:100%;padding:11px 13px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;font-family:inherit;cursor:pointer;">
                  ${unitOptions}
                </select>
              </div>
              <div>
                <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px;font-weight:700;text-transform:uppercase;">${c.priceLabel||'Price (KES)'}</div>
                <input type="number" id="simPrice" placeholder="0" min="0" style="width:100%;padding:11px 13px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;font-family:inherit;">
              </div>
              <div>
                <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px;font-weight:700;text-transform:uppercase;">${c.stockLabel||'Qty in Stock'}</div>
                <input type="number" id="simStock" placeholder="0" min="0" style="width:100%;padding:11px 13px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;font-size:13px;outline:none;font-family:inherit;">
              </div>
            </div>
            ${extraInputs}
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;">
              <button type="button" onclick="SokoniInventory._save()" style="padding:12px 28px;background:linear-gradient(135deg,${c.color},${c.color}cc);color:${_isDark(c.color)?'white':'black'};font-weight:900;font-size:13px;border:none;border-radius:11px;cursor:pointer;font-family:inherit;">💾 Save ${c.label}</button>
              <button type="button" id="simCancelEdit" onclick="SokoniInventory._cancelEdit()" style="display:none;padding:12px 20px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.5);font-size:13px;font-weight:700;border-radius:11px;cursor:pointer;font-family:inherit;">Cancel Edit</button>
            </div>
          </div>

          <!-- Danger zone -->
          <div style="margin-top:28px;padding:14px 18px;background:rgba(220,38,38,0.04);border:1px solid rgba(220,38,38,0.15);border-radius:14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
            <div style="font-size:12px;color:rgba(255,255,255,0.3);line-height:1.5;">Clear all inventory data from this device.</div>
            <button type="button" onclick="SokoniInventory._clearAll()" style="padding:8px 16px;background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.25);color:#ef4444;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">🗑️ Clear All Inventory</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div);
  }

  function _isDark(hex){
    try{ const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16); return (0.299*r+0.587*g+0.114*b)<128; }catch(e){ return true; }
  }

  /* ── Render list ── */
  function _render(){
    const q = (document.getElementById('simSearch')||{}).value||'';
    const f = (document.getElementById('simFilter')||{}).value||'';
    let list = _items;
    if(q) list = list.filter(m=>m.name.toLowerCase().includes(q.toLowerCase())||m.category.toLowerCase().includes(q.toLowerCase()));
    if(f==='available') list = list.filter(m=>m.available&&m.stock>0);
    if(f==='unavailable') list = list.filter(m=>!m.available||m.stock===0);

    const el = document.getElementById('simList');
    if(!el) return;
    if(!list.length){
      el.innerHTML=`<div style="text-align:center;padding:40px 0;color:rgba(255,255,255,0.25);font-size:13px;">${_items.length?'No items match your filter.':'No items yet — add your first one below ↓'}</div>`;
      _updateStats(); return;
    }
    const c = _cfg;
    el.innerHTML = list.map(m=>{
      const extra = (c.extraFields||[]).filter(f=>m[f.id]).map(f=>{
        if(f.type==='checkbox') return m[f.id]?`<span style="background:rgba(255,80,80,0.15);color:#ff6b6b;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;">${f.label}</span>`:'';
        return `<span style="color:rgba(255,255,255,0.4);font-size:11px;">${f.label}: ${m[f.id]}</span>`;
      }).filter(Boolean).join(' ');
      const inStock = m.available && m.stock > 0;
      return `
        <div style="display:flex;align-items:center;gap:12px;padding:13px 16px;background:rgba(255,255,255,${inStock?'0.03':'0.01'});border:1px solid rgba(255,255,255,${inStock?'0.08':'0.04'});border-radius:13px;margin-bottom:8px;transition:.2s;">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
              <span style="font-size:13px;font-weight:800;color:white;">${m.name}</span>
              <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.5);">${m.category}</span>
              ${extra}
            </div>
            <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:rgba(255,255,255,0.45);">
              <span style="color:${c.color};font-weight:700;">KES ${Number(m.price||0).toLocaleString()} / ${m.unit}</span>
              <span style="color:${m.stock>10?'#00c878':m.stock>0?'#fbbf24':'#ff6b6b'};">Stock: ${m.stock} ${m.unit}${m.stock!==1?'s':''}</span>
              <span style="color:${inStock?'#00c878':'#ff6b6b'};">● ${inStock?'Available':'Unavailable'}</span>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;">
            <button type="button" onclick="SokoniInventory._toggle('${m.id}')" style="padding:6px 11px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.55);font-size:11px;cursor:pointer;font-family:inherit;font-weight:700;">${inStock?'Pause':'Activate'}</button>
            <button type="button" onclick="SokoniInventory._edit('${m.id}')" style="padding:6px 11px;border-radius:8px;border:1px solid rgba(0,180,255,0.2);background:rgba(0,180,255,0.06);color:#60aaff;font-size:11px;cursor:pointer;font-family:inherit;font-weight:700;">Edit</button>
            <button type="button" onclick="SokoniInventory._delete('${m.id}')" style="padding:6px 11px;border-radius:8px;border:1px solid rgba(255,60,60,0.2);background:rgba(255,60,60,0.05);color:#ff6b6b;font-size:11px;cursor:pointer;font-family:inherit;font-weight:700;">✕</button>
          </div>
        </div>`;
    }).join('');
    _updateStats();
  }

  function _updateStats(){
    const el = document.getElementById('simStats'); if(!el) return;
    const total=_items.length, avail=_items.filter(m=>m.available&&m.stock>0).length;
    el.textContent = `${avail} available · ${total-avail} unavailable · ${total} total`;
  }

  /* ── CRUD ── */
  function _saveItem(){
    const name  = (document.getElementById('simName')||{}).value?.trim();
    const cat   = (document.getElementById('simCategory')||{}).value;
    const unit  = (document.getElementById('simUnit')||{}).value;
    const price = parseFloat((document.getElementById('simPrice')||{}).value||0);
    const stock = parseInt((document.getElementById('simStock')||{}).value||0, 10);
    if(!name){ (window._skToast||alert)('⚠️ Item name is required.'); return; }

    const extra = {};
    (_cfg.extraFields||[]).forEach(f=>{
      const el = document.getElementById('simExt_'+f.id);
      if(!el) return;
      extra[f.id] = f.type==='checkbox' ? el.checked : el.value.trim();
    });

    if(_editId){
      const m = _items.find(x=>x.id===_editId);
      if(m) Object.assign(m, { name, category:cat, unit, price, stock, available:stock>0, ...extra, updatedAt:Date.now() });
      _editId=null;
    } else {
      _items.unshift({ id:'INV'+Date.now().toString(36).toUpperCase(), name, category:cat, unit, price, stock, available:stock>0, ...extra, createdAt:Date.now() });
    }
    _save(); _clearForm(); _render();
  }

  function _edit(id){
    const m = _items.find(x=>x.id===id); if(!m) return;
    _editId = id;
    const set = (elId, val) => { const e=document.getElementById(elId); if(e) e.value=val; };
    set('simName', m.name); set('simCategory', m.category); set('simUnit', m.unit);
    set('simPrice', m.price); set('simStock', m.stock);
    (_cfg.extraFields||[]).forEach(f=>{
      const el = document.getElementById('simExt_'+f.id); if(!el) return;
      if(f.type==='checkbox') el.checked=!!m[f.id]; else el.value=m[f.id]||'';
    });
    const ft = document.getElementById('simFormTitle');
    if(ft) ft.textContent = '✏️ Edit '+_cfg.label;
    const ce = document.getElementById('simCancelEdit');
    if(ce) ce.style.display='';
    document.getElementById('simForm')?.scrollIntoView({behavior:'smooth', block:'start'});
  }

  function _cancelEdit(){
    _editId=null; _clearForm();
    const ft=document.getElementById('simFormTitle'); if(ft) ft.textContent='➕ Add '+_cfg.label;
    const ce=document.getElementById('simCancelEdit'); if(ce) ce.style.display='none';
  }

  function _clearForm(){
    ['simName','simPrice','simStock'].forEach(id=>{ const e=document.getElementById(id); if(e) e.value=''; });
    (_cfg.extraFields||[]).forEach(f=>{
      const el=document.getElementById('simExt_'+f.id); if(!el) return;
      if(f.type==='checkbox') el.checked=false; else el.value='';
    });
    const ft=document.getElementById('simFormTitle'); if(ft) ft.textContent='➕ Add '+_cfg.label;
    const ce=document.getElementById('simCancelEdit'); if(ce) ce.style.display='none';
    _editId=null;
  }

  function _toggle(id){
    const m=_items.find(x=>x.id===id); if(!m) return;
    m.available=!m.available; _save(); _render();
  }

  function _delete(id){
    if(!_c){_skConfirm('Remove this item from your inventory?',()=>_doInvRm(_iid,true));return;}
    _items=_items.filter(x=>x.id!==id); _save(); _render();
  }

  function _clearAll(){
    if(!_c){_skConfirm('Clear ALL inventory items? This cannot be undone.',()=>_doInvClear(true));return;}
    _items=[]; _save(); _render();
  }

  /* ── Public API ── */
  function open(opts){
    opts = opts || {};
    _preset = opts.preset || _detectPreset();
    _cfg = Object.assign({}, PRESETS[_preset] || PRESETS.general, opts.overrides||{});
    _ownerKey = opts.ownerKey || null;
    _load();

    /* Remove old modal if preset changed */
    const old = document.getElementById(_modalId);
    if(old) old.remove();
    _buildModal();

    const titleEl = document.getElementById('simTitle');
    if(titleEl){
      const owner = _ownerKey ? (()=>{ try{ const p=JSON.parse(localStorage.getItem(_ownerKey)||'null'); return p?(' — '+(p.name||'')):''; }catch(e){ return ''; } })() : '';
      titleEl.textContent = _cfg.icon+' '+(_cfg.pluralLabel||_cfg.label+'s')+owner;
    }
    _render();
    const m = document.getElementById(_modalId);
    if(m){ m.style.display='flex'; m.scrollTop=0; }
  }

  function openForProvider(){
    const p = (()=>{ try{ return JSON.parse(localStorage.getItem('sokoniProviderProfile')||'null'); }catch(e){ return null; } })();
    open({ preset: _detectPreset(), ownerKey:'sokoniProviderProfile', overrides: p?{ storageKey:'sokoniInventory_'+(p.cat||'general') }:{} });
  }

  function close(){
    const m = document.getElementById(_modalId); if(m) m.style.display='none';
  }

  /* Expose PRESETS list for pages that want to build a picker */
  function getPresets(){ return Object.keys(PRESETS); }

  return { open, openForProvider, close, _render, _save:_saveItem, _edit, _cancelEdit, _delete, _toggle, _clearAll, getPresets, PRESETS };

})();



