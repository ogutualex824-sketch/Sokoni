/* ============================================================
   SOKONI B2B  — sokoni-b2b.js
   window.SokoniB2B  IIFE module
   Supplier directory · RFQ engine · Quotation management
   Orders · Messaging · Analytics · Firestore integration
============================================================ */
;(function(){
'use strict';

/* ── Firestore collection map ── */
const _B2B_COLL = {
  'b2b_rfqs':'b2bRFQs', 'b2b_quotes':'b2bQuotes', 'b2b_orders':'b2bOrders',
  'b2b_messages':'b2bMessages', 'b2b_suppliers':'b2bSuppliers',
  'b2b_products':'b2bProducts', 'b2b_ratings':'b2bRatings', 'b2b_invoices':'b2bInvoices',
};
const _B2B_CFG = {apiKey:"AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE",authDomain: "auth.mysokoni.co.ke",projectId:"sokoni-aeb26",storageBucket:"sokoni-aeb26.firebasestorage.app",messagingSenderId:"24799054989",appId:"1:24799054989:web:e1cf6ca8c281bf1abf26c4"};

function fsWrite(col, data) {
  const fsColl = _B2B_COLL[col] || col;
  (async()=>{try{
    const {initializeApp,getApps}=await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
    const {getFirestore,collection,doc,addDoc,setDoc,serverTimestamp}=await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
    const _a=getApps().find(a=>a.name==="b2b-fs")||initializeApp(_B2B_CFG,"b2b-fs");
    const db=getFirestore(_a);
    const payload={...data,_savedAt:serverTimestamp()};
    if(data.id) await setDoc(doc(db,fsColl,data.id),payload,{merge:true});
    else await addDoc(collection(db,fsColl),payload);
  }catch(e){}})();
}

function fsRead(col) {
  try { return JSON.parse(localStorage.getItem('b2b_' + col)||'[]'); } catch(e){ return []; }
}

/* ── SUPPLIER TYPES ── */
const SUPPLIER_TYPES = [
  {id:'all',label:'All Suppliers',icon:'🏢'},
  {id:'manufacturer',label:'Manufacturers',icon:'🏭'},
  {id:'wholesaler',label:'Wholesalers',icon:'📦'},
  {id:'distributor',label:'Distributors',icon:'🚛'},
  {id:'importer',label:'Importers',icon:'🌍'},
  {id:'exporter',label:'Exporters',icon:'✈️'},
  {id:'service',label:'Service Providers',icon:'🛠️'},
];

/* ── INDUSTRY CATEGORIES ── */
const INDUSTRIES = [
  {id:'all',label:'All Industries',icon:'🌐'},
  {id:'agriculture',label:'Agriculture',icon:'🌱'},
  {id:'electronics',label:'Electronics',icon:'📱'},
  {id:'fashion',label:'Fashion & Textiles',icon:'👕'},
  {id:'food',label:'Food & Beverages',icon:'🍎'},
  {id:'construction',label:'Construction',icon:'🧱'},
  {id:'chemicals',label:'Chemicals & Cleaning',icon:'🧪'},
  {id:'machinery',label:'Machinery & Tools',icon:'⚙️'},
  {id:'healthcare',label:'Healthcare & Pharma',icon:'💊'},
  {id:'printing',label:'Printing & Branding',icon:'🖨️'},
  {id:'logistics',label:'Logistics & Transport',icon:'🚚'},
  {id:'beauty',label:'Beauty & Personal Care',icon:'💄'},
  {id:'furniture',label:'Furniture & Décor',icon:'🛋️'},
  {id:'stationery',label:'Stationery & Office',icon:'📝'},
  {id:'auto',label:'Auto Parts & Accessories',icon:'🔩'},
];

/* ── SUPPLIER DIRECTORY ── */
const SUPPLIERS = [
  {id:'sup001',name:'Nairobi Apparel Co.',type:'manufacturer',industry:'fashion',location:'Industrial Area, Nairobi',city:'nairobi',verified:true,rating:4.8,reviews:142,established:2012,employees:'50-200',desc:'Kenya\'s leading garment manufacturer. Custom clothing, uniforms, branded wear. Export-ready with EU certifications.',minOrder:'KES 50,000',phone:'0712345001',exportReady:true,tags:['uniforms','custom-branding','export'],certifications:['ISO 9001','KEBS'],catalog:['ws001','ws002']},
  {id:'sup002',name:'TechHub Kenya Ltd.',type:'distributor',industry:'electronics',location:'Westlands, Nairobi',city:'nairobi',verified:true,rating:4.7,reviews:98,established:2016,employees:'10-50',desc:'Authorized distributor of smartphones, tablets, accessories and computing equipment. Direct supply to corporates and retailers.',minOrder:'KES 100,000',phone:'0723456002',exportReady:false,tags:['smartphones','laptops','b2b-tech'],certifications:['Samsung Partner','Safaricom Reseller'],catalog:['ws003','ws004']},
  {id:'sup003',name:'Rift Valley Mills',type:'manufacturer',industry:'food',location:'Nakuru',city:'nakuru',verified:true,rating:4.9,reviews:210,established:2005,employees:'200-500',desc:'Large-scale milling company producing maize flour, wheat flour, animal feeds. KEBS-certified. Retail and bulk packing available.',minOrder:'KES 30,000',phone:'0734567003',exportReady:true,tags:['flour','grains','animal-feeds'],certifications:['KEBS','KEPHA','ISO 22000'],catalog:['ws005','ws006']},
  {id:'sup004',name:'Murang\'a Farmers Cooperative',type:'exporter',industry:'agriculture',location:'Murang\'a',city:'murang\'a',verified:true,rating:4.6,reviews:87,established:2008,employees:'200-500',desc:'Farmer cooperative exporting avocado, macadamia, coffee. GlobalGAP certified. Direct farm-to-buyer. MOQ negotiable.',minOrder:'KES 20,000',phone:'0745678004',exportReady:true,tags:['avocado','macadamia','export','GlobalGAP'],certifications:['GlobalGAP','KEPHIS'],catalog:['ws007']},
  {id:'sup005',name:'Beauty Depot Kenya',type:'wholesaler',industry:'beauty',location:'Mombasa',city:'mombasa',verified:true,rating:4.5,reviews:63,established:2014,employees:'10-50',desc:'Wholesale distributor of salon products, cosmetics and personal care. Brands: Revlon, ORS, Dark & Lovely and private label.',minOrder:'KES 15,000',phone:'0756789005',exportReady:false,tags:['cosmetics','salon','wholesale'],certifications:['KFDA Registered'],catalog:['ws008']},
  {id:'sup006',name:'FurnishPro East Africa',type:'manufacturer',industry:'furniture',location:'Industrial Area, Nairobi',city:'nairobi',verified:true,rating:4.7,reviews:119,established:2010,employees:'50-200',desc:'Contract furniture manufacturer. Office, hotel, school and residential furniture. Custom projects accepted. Showroom available.',minOrder:'KES 80,000',phone:'0767890006',exportReady:true,tags:['office-furniture','hotel','contract'],certifications:['KEBS'],catalog:['ws009','ws010']},
  {id:'sup007',name:'CleanCo Kenya',type:'manufacturer',industry:'chemicals',location:'Thika Road, Nairobi',city:'nairobi',verified:true,rating:4.4,reviews:44,established:2017,employees:'10-50',desc:'Manufacturer of industrial and household cleaning chemicals. White-label manufacturing available. Custom formulations.',minOrder:'KES 25,000',phone:'0778901007',exportReady:false,tags:['detergents','cleaning','white-label'],certifications:['KEBS','KFDA'],catalog:['ws011']},
  {id:'sup008',name:'ToolsKE Distributors',type:'distributor',industry:'machinery',location:'Industrial Area, Nairobi',city:'nairobi',verified:true,rating:4.6,reviews:77,established:2013,employees:'10-50',desc:'Authorized distributor of Bosch, DeWalt and local power tools. Hardware, safety equipment and site supplies.',minOrder:'KES 40,000',phone:'0789012008',exportReady:false,tags:['power-tools','hardware','bosch','dewalt'],certifications:['Bosch Partner','DeWalt Authorized'],catalog:['ws012','ws013']},
  {id:'sup009',name:'Kariuki Textiles Ltd.',type:'importer',industry:'fashion',location:'Eastleigh, Nairobi',city:'nairobi',verified:true,rating:4.3,reviews:55,established:2009,employees:'10-50',desc:'Importer of Ankara fabric, lace, cotton and polyester materials. Direct from West Africa and China. Retail and wholesale.',minOrder:'KES 10,000',phone:'0790123009',exportReady:false,tags:['ankara','fabric','textiles','eastleigh'],certifications:['KRA Registered'],catalog:['ws014','ws015']},
  {id:'sup010',name:'SolarKe Solutions',type:'distributor',industry:'electronics',location:'Karen, Nairobi',city:'nairobi',verified:true,rating:4.8,reviews:132,established:2015,employees:'50-200',desc:'Solar panels, batteries, inverters and complete solar systems. County-level supply and installation. Government approved.',minOrder:'KES 200,000',phone:'0701234010',exportReady:false,tags:['solar','energy','off-grid'],certifications:['ERC Registered','REA Partner'],catalog:['ws016']},
  {id:'sup011',name:'MedSupply Kenya',type:'distributor',industry:'healthcare',location:'Upper Hill, Nairobi',city:'nairobi',verified:true,rating:4.9,reviews:188,established:2011,employees:'50-200',desc:'Medical supplies: PPE, consumables, diagnostic kits, hospital furniture. Licensed by PPB. Government and private sector.',minOrder:'KES 50,000',phone:'0712345011',exportReady:false,tags:['medical','PPE','hospital','diagnostic'],certifications:['PPB Registered','ISO 13485'],catalog:['ws017','ws018']},
  {id:'sup012',name:'Embroidery House Kenya',type:'service',industry:'printing',location:'Westlands, Nairobi',city:'nairobi',verified:true,rating:4.7,reviews:96,established:2013,employees:'10-50',desc:'Corporate branding: embroidery, screen printing, digital printing, promotional merchandise. 5-day standard turnaround.',minOrder:'KES 8,000',phone:'0723456012',exportReady:false,tags:['branding','embroidery','print','merchandise'],certifications:['KRA Registered'],catalog:['ws019','ws020']},
  {id:'sup013',name:'Agri-Inputs Kenya',type:'distributor',industry:'agriculture',location:'Nakuru',city:'nakuru',verified:true,rating:4.5,reviews:71,established:2014,employees:'10-50',desc:'Fertilizers, seeds, pesticides and farm equipment. Authorized dealer of Yara, SeedCo. County delivery available.',minOrder:'KES 20,000',phone:'0734567013',exportReady:false,tags:['fertilizer','seeds','pesticides','farm'],certifications:['PCPB Licensed','KEPHIS'],catalog:['ws021']},
  {id:'sup014',name:'BuildRight Materials Ltd.',type:'wholesaler',industry:'construction',location:'Mombasa Road, Nairobi',city:'nairobi',verified:true,rating:4.4,reviews:58,established:2016,employees:'10-50',desc:'Building materials: cement, steel bars, timber, roofing. Bulk site deliveries. Open-term credit for contractors.',minOrder:'KES 100,000',phone:'0745678014',exportReady:false,tags:['cement','steel','timber','roofing'],certifications:['KRA Registered'],catalog:['ws022','ws023']},
  {id:'sup015',name:'Swift Logistics Kenya',type:'service',industry:'logistics',location:'Jomo Kenyatta Airport Area, Nairobi',city:'nairobi',verified:true,rating:4.6,reviews:103,established:2012,employees:'50-200',desc:'Freight forwarding, customs clearance, warehousing and last-mile delivery. B2B and B2C. Air, sea, road options.',minOrder:'Quotation based',phone:'0756789015',exportReady:true,tags:['freight','clearance','warehousing','last-mile'],certifications:['KAA Licensed','KIFWA Member'],catalog:[]},
];

/* ── PRODUCT CATALOG ── */
const PRODUCTS = [
  {id:'ws001',supplierId:'sup001',supplierName:'Nairobi Apparel Co.',name:'Corporate Polo Shirts (Branded)',category:'fashion',price:900,wholesalePrice:480,moq:30,unit:'pcs',desc:'100% cotton polo, custom embroidery or screen-print. 5 working days. Sizes S-5XL.',savings:47},
  {id:'ws002',supplierId:'sup001',supplierName:'Nairobi Apparel Co.',name:'Staff Uniforms (Complete Set)',category:'fashion',price:2800,wholesalePrice:1600,moq:20,unit:'sets',desc:'Shirt + trouser + jacket set. Custom colours, logo embroidery. 7-day turnaround.',savings:43},
  {id:'ws003',supplierId:'sup002',supplierName:'TechHub Kenya Ltd.',name:'Android Smartphones (4G Bulk)',category:'electronics',price:12000,wholesalePrice:8500,moq:10,unit:'units',desc:'Budget Android 4G, 32GB, 3GB RAM. 12-month warranty. Customs cleared. Mix model available.',savings:29},
  {id:'ws004',supplierId:'sup002',supplierName:'TechHub Kenya Ltd.',name:'Business Laptops (i5/8GB)',category:'electronics',price:65000,wholesalePrice:48000,moq:5,unit:'units',desc:'Core i5, 8GB RAM, 256GB SSD. Pre-configured. 1-year warranty. Corporate invoicing available.',savings:26},
  {id:'ws005',supplierId:'sup003',supplierName:'Rift Valley Mills',name:'Maize Flour 2kg (Retail Packs)',category:'food',price:180,wholesalePrice:110,moq:100,unit:'bags',desc:'Grade 1 super maize flour, 2kg white-branded packs. Shelf life 12 months. County distribution.',savings:39},
  {id:'ws006',supplierId:'sup003',supplierName:'Rift Valley Mills',name:'Wheat Flour 1kg (Wholesale)',category:'food',price:120,wholesalePrice:72,moq:200,unit:'bags',desc:'Premium wheat flour, 1kg packs. Suitable for bakeries. Consistent quality.',savings:40},
  {id:'ws007',supplierId:'sup004',supplierName:'Murang\'a Farmers Cooperative',name:'Hass Avocado (Export Grade)',category:'agriculture',price:80,wholesalePrice:35,moq:500,unit:'kg',desc:'Grade A Hass avocado. Export quality. Cold-chain available. Reliable supply Feb–Nov.',savings:56},
  {id:'ws008',supplierId:'sup005',supplierName:'Beauty Depot Kenya',name:'Salon Hair Products Set',category:'beauty',price:3500,wholesalePrice:1800,moq:20,unit:'sets',desc:'Relaxer + shampoo + conditioner professional pack. Branded packaging. Nationwide delivery.',savings:49},
  {id:'ws009',supplierId:'sup006',supplierName:'FurnishPro East Africa',name:'Ergonomic Office Chair',category:'furniture',price:18000,wholesalePrice:11000,moq:5,unit:'units',desc:'Mesh ergonomic chair, lumbar support, 5-year frame warranty. Free Nairobi delivery > 10 units.',savings:39},
  {id:'ws010',supplierId:'sup006',supplierName:'FurnishPro East Africa',name:'Executive Office Desk (1.8m)',category:'furniture',price:28000,wholesalePrice:17500,moq:3,unit:'units',desc:'Melamine finish, cable management, lockable drawers. Custom sizes available.',savings:38},
  {id:'ws011',supplierId:'sup007',supplierName:'CleanCo Kenya',name:'Floor Cleaning Detergent 5L',category:'chemicals',price:600,wholesalePrice:320,moq:24,unit:'bottles',desc:'Industrial-grade liquid floor cleaner. Lemon/pine variants. White-label available.',savings:47},
  {id:'ws012',supplierId:'sup008',supplierName:'ToolsKE Distributors',name:'Cordless Drill Set (18V)',category:'machinery',price:8500,wholesalePrice:5200,moq:5,unit:'units',desc:'18V brushless drill, 21-piece bit set, 2 batteries. 1-year warranty. Bosch authorized.',savings:39},
  {id:'ws013',supplierId:'sup008',supplierName:'ToolsKE Distributors',name:'Safety Workwear Kit',category:'machinery',price:3200,wholesalePrice:1900,moq:10,unit:'kits',desc:'Hard hat + reflective vest + safety boots + gloves. OSHA compliant. Custom branding available.',savings:41},
  {id:'ws014',supplierId:'sup009',supplierName:'Kariuki Textiles Ltd.',name:'Ankara Fabric Rolls (6 yards)',category:'fashion',price:1800,wholesalePrice:980,moq:20,unit:'rolls',desc:'Premium wax print Ankara, 100% cotton. 50+ patterns in stock. New stock monthly.',savings:46},
  {id:'ws015',supplierId:'sup009',supplierName:'Kariuki Textiles Ltd.',name:'Plain Cotton Fabric (Per Metre)',category:'fashion',price:280,wholesalePrice:150,moq:50,unit:'metres',desc:'200gsm plain cotton. 30+ colours. Ideal for uniforms and school wear.',savings:46},
  {id:'ws016',supplierId:'sup010',supplierName:'SolarKe Solutions',name:'300W Solar Panel + Battery Kit',category:'electronics',price:85000,wholesalePrice:58000,moq:2,unit:'systems',desc:'300W monocrystalline panel + 200Ah battery + inverter. 10-year panel warranty. Installation included Nairobi.',savings:32},
  {id:'ws017',supplierId:'sup011',supplierName:'MedSupply Kenya',name:'Surgical Gloves (Box of 100)',category:'healthcare',price:1200,wholesalePrice:650,moq:50,unit:'boxes',desc:'Latex-free nitrile gloves. S/M/L. PPB registered. Ideal for clinics and hospitals.',savings:46},
  {id:'ws018',supplierId:'sup011',supplierName:'MedSupply Kenya',name:'Rapid Test Kits (Malaria/COVID)',category:'healthcare',price:350,wholesalePrice:190,moq:100,unit:'kits',desc:'WHO pre-qualified rapid diagnostic kits. Cold-chain supplied. Government approved.',savings:46},
  {id:'ws019',supplierId:'sup012',supplierName:'Embroidery House Kenya',name:'Branded T-Shirts (Printed)',category:'printing',price:900,wholesalePrice:420,moq:30,unit:'pcs',desc:'Premium 180g cotton tee, full-colour digital print. 5 days. Pantone colour matching.',savings:53},
  {id:'ws020',supplierId:'sup012',supplierName:'Embroidery House Kenya',name:'Branded Caps (Embroidered)',category:'printing',price:750,wholesalePrice:380,moq:50,unit:'pcs',desc:'6-panel baseball cap, custom embroidery up to 10k stitches. 5-day lead time.',savings:49},
  {id:'ws021',supplierId:'sup013',supplierName:'Agri-Inputs Kenya',name:'NPK Fertilizer (50kg Bag)',category:'agriculture',price:5500,wholesalePrice:3800,moq:20,unit:'bags',desc:'Balanced NPK 17-17-17. PCPB approved. Bulk pricing available > 100 bags. County delivery.',savings:31},
  {id:'ws022',supplierId:'sup014',supplierName:'BuildRight Materials Ltd.',name:'Portland Cement (50kg)',category:'construction',price:780,wholesalePrice:620,moq:100,unit:'bags',desc:'Grade 32.5N Portland cement. Site delivery Nairobi & Mombasa. Credit terms for contractors.',savings:21},
  {id:'ws023',supplierId:'sup014',supplierName:'BuildRight Materials Ltd.',name:'Steel Rebar Y12 (12m)',category:'construction',price:1800,wholesalePrice:1350,moq:50,unit:'bars',desc:'Y12 deformed steel bars, 12m length. BS 4449 standard. Mill certificates provided.',savings:25},
];

/* ── CAT EMOJI MAP ── */
const CAT_ICONS = {
  fashion:'👕', electronics:'📱', food:'🍎', agriculture:'🌱', beauty:'💄',
  furniture:'🛋️', chemicals:'🧪', machinery:'⚙️', healthcare:'💊',
  printing:'🖨️', logistics:'🚚', construction:'🧱', auto:'🔩', stationery:'📝',
};

/* ── RFQ STATUS ── */
const RFQ_STATUS = {
  open:   {label:'Open',color:'#22c55e'},
  quoted: {label:'Quoted',color:'#3b82f6'},
  awarded:{label:'Awarded',color:'#f59e0b'},
  closed: {label:'Closed',color:'rgba(255,255,255,0.3)'},
};

/* ── QUOTE STATUS ── */
const QUOTE_STATUS = {
  pending:    {label:'Pending Review',color:'rgba(255,255,255,0.5)'},
  accepted:   {label:'Accepted',color:'#22c55e'},
  rejected:   {label:'Rejected',color:'#ef4444'},
  negotiating:{label:'Negotiating',color:'#f59e0b'},
  expired:    {label:'Expired',color:'rgba(255,255,255,0.3)'},
};

/* ── ORDER STATUS ── */
const ORDER_STATUS = {
  pending:    {label:'Pending Payment',icon:'🕐'},
  confirmed:  {label:'Confirmed',icon:'✅'},
  processing: {label:'Processing',icon:'⚙️'},
  dispatched: {label:'Dispatched',icon:'🚛'},
  delivered:  {label:'Delivered',icon:'📦'},
  cancelled:  {label:'Cancelled',icon:'✗'},
};

/* ══════════════════════════════════════════════
   RFQ  FUNCTIONS
══════════════════════════════════════════════ */
function createRFQ(data) {
  const id = 'RFQ' + Date.now();
  const rfq = {
    id, ...data,
    status: 'open',
    quotes: [],
    views: 0,
    createdAt: Date.now(),
    uid: _getUid(),
  };
  const arr = getRFQs();
  arr.unshift(rfq);
  localStorage.setItem('b2b_rfqs', JSON.stringify(arr.slice(0,200)));
  fsWrite('b2b_rfqs', rfq);
  return rfq;
}

function getRFQs(uid) {
  const all = JSON.parse(localStorage.getItem('b2b_rfqs')||'[]');
  return uid ? all.filter(r => r.uid === uid) : all;
}

function getRFQById(id) {
  return getRFQs().find(r => r.id === id);
}

function updateRFQStatus(id, status) {
  const arr = getRFQs();
  const idx = arr.findIndex(r => r.id === id);
  if (idx > -1) { arr[idx].status = status; arr[idx].updatedAt = Date.now(); }
  localStorage.setItem('b2b_rfqs', JSON.stringify(arr));
  if (idx > -1) fsWrite('b2b_rfqs', arr[idx]);
}

function deleteRFQ(id) {
  const arr = getRFQs().filter(r => r.id !== id);
  localStorage.setItem('b2b_rfqs', JSON.stringify(arr));
}

/* ══════════════════════════════════════════════
   QUOTATION  FUNCTIONS
══════════════════════════════════════════════ */
function submitQuote(data) {
  const id = 'QT' + Date.now();
  const quote = {
    id, ...data,
    status: 'pending',
    createdAt: Date.now(),
    supplierId: data.supplierId || _getUid(),
  };
  const arr = getQuotes();
  arr.unshift(quote);
  localStorage.setItem('b2b_quotes', JSON.stringify(arr.slice(0,500)));
  fsWrite('b2b_quotes', quote);
  /* Attach to RFQ */
  const rfqs = getRFQs();
  const rfqIdx = rfqs.findIndex(r => r.id === data.rfqId);
  if (rfqIdx > -1) {
    if (!rfqs[rfqIdx].quotes) rfqs[rfqIdx].quotes = [];
    rfqs[rfqIdx].quotes.push(id);
    rfqs[rfqIdx].status = 'quoted';
    localStorage.setItem('b2b_rfqs', JSON.stringify(rfqs));
  }
  addNotification({
    type:'quote', title:'New Quote Received',
    body:`${data.supplierName} submitted a quote for your RFQ`,
    rfqId: data.rfqId, quoteId: id,
  });
  return quote;
}

function getQuotes(rfqId) {
  const all = JSON.parse(localStorage.getItem('b2b_quotes')||'[]');
  return rfqId ? all.filter(q => q.rfqId === rfqId) : all;
}

function getQuoteById(id) {
  return getQuotes().find(q => q.id === id);
}

function updateQuoteStatus(id, status) {
  const arr = getQuotes();
  const idx = arr.findIndex(q => q.id === id);
  if (idx > -1) { arr[idx].status = status; arr[idx].updatedAt = Date.now(); }
  localStorage.setItem('b2b_quotes', JSON.stringify(arr));
  if (idx > -1) fsWrite('b2b_quotes', arr[idx]);
}

function acceptQuote(quoteId, rfqId) {
  updateQuoteStatus(quoteId, 'accepted');
  updateRFQStatus(rfqId, 'awarded');
  /* Reject all other quotes for this RFQ */
  getQuotes(rfqId).filter(q => q.id !== quoteId).forEach(q => updateQuoteStatus(q.id, 'rejected'));
}

/* ══════════════════════════════════════════════
   ORDER  FUNCTIONS
══════════════════════════════════════════════ */
function createOrder(data) {
  const id = 'PO' + Date.now();
  const order = {
    id, ...data,
    status: 'pending',
    paymentStatus: 'unpaid',
    createdAt: Date.now(),
    uid: _getUid(),
    trackingRef: 'SK' + Math.random().toString(36).slice(2,8).toUpperCase(),
  };
  const arr = getOrders();
  arr.unshift(order);
  localStorage.setItem('b2b_orders', JSON.stringify(arr.slice(0,200)));
  fsWrite('b2b_orders', order);
  addNotification({
    type:'order', title:'Purchase Order Created',
    body:`PO ${id} created for ${data.supplierName}`,
    orderId: id,
  });
  return order;
}

function getOrders(uid) {
  const all = JSON.parse(localStorage.getItem('b2b_orders')||'[]');
  return uid ? all.filter(o => o.uid === uid) : all;
}

function getOrderById(id) {
  return getOrders().find(o => o.id === id);
}

function updateOrderStatus(id, status) {
  const arr = getOrders();
  const idx = arr.findIndex(o => o.id === id);
  if (idx > -1) {
    arr[idx].status = status;
    arr[idx].updatedAt = Date.now();
    if (!arr[idx].history) arr[idx].history = [];
    arr[idx].history.push({status, ts: Date.now()});
  }
  localStorage.setItem('b2b_orders', JSON.stringify(arr));
  if (idx > -1) fsWrite('b2b_orders', arr[idx]);
}

/* ══════════════════════════════════════════════
   MESSAGING
══════════════════════════════════════════════ */
function sendMessage(data) {
  const id = 'MSG' + Date.now();
  const msg = { id, ...data, ts: Date.now(), read: false };
  const key = 'b2b_chat_' + data.threadId;
  const arr = JSON.parse(localStorage.getItem(key)||'[]');
  arr.push(msg);
  localStorage.setItem(key, JSON.stringify(arr.slice(0,500)));
  fsWrite('b2b_messages', msg);
  return msg;
}

function getMessages(threadId) {
  return JSON.parse(localStorage.getItem('b2b_chat_' + threadId)||'[]');
}

function _threadName(threadId) {
  if (threadId.startsWith('rfq_')) {
    const rfq = getRFQById(threadId.replace('rfq_',''));
    return rfq ? 'RFQ: ' + rfq.title : 'RFQ #' + threadId.replace('rfq_','');
  }
  if (threadId.startsWith('order_')) return 'Order ' + threadId.replace('order_','');
  if (threadId.startsWith('supplier_')) {
    const sup = getSupplierById(threadId.replace('supplier_',''));
    return sup ? sup.name : threadId.replace('supplier_','');
  }
  return threadId;
}

function getThreads() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('b2b_chat_'));
  return keys.map(k => {
    const msgs = JSON.parse(localStorage.getItem(k)||'[]');
    const last = msgs[msgs.length - 1];
    const threadId = k.replace('b2b_chat_','');
    const name = _threadName(threadId);
    return { id: threadId, threadId, name, lastMsg: last, unread: msgs.filter(m=>!m.read).length };
  }).sort((a,b) => (b.lastMsg?.ts||0) - (a.lastMsg?.ts||0));
}

function markThreadRead(threadId) {
  const key = 'b2b_chat_' + threadId;
  const arr = JSON.parse(localStorage.getItem(key)||'[]').map(m => ({...m, read:true}));
  localStorage.setItem(key, JSON.stringify(arr));
}

/* ══════════════════════════════════════════════
   NOTIFICATIONS
══════════════════════════════════════════════ */
function addNotification(data) {
  const arr = getNotifications();
  arr.unshift({ id:'BN'+Date.now(), ...data, ts: Date.now(), read: false });
  localStorage.setItem('b2b_notifications', JSON.stringify(arr.slice(0,100)));
}

function getNotifications() {
  return JSON.parse(localStorage.getItem('b2b_notifications')||'[]');
}

function markNotifsRead() {
  const arr = getNotifications().map(n => ({...n, read:true}));
  localStorage.setItem('b2b_notifications', JSON.stringify(arr));
}

function getUnreadCount() {
  return getNotifications().filter(n => !n.read).length;
}

/* ══════════════════════════════════════════════
   SUPPLIER FUNCTIONS
══════════════════════════════════════════════ */
function getSuppliers(filter) {
  let list = [...SUPPLIERS, ...fsRead('b2b_suppliers')];
  if (filter?.type && filter.type !== 'all')     list = list.filter(s => s.type === filter.type);
  if (filter?.industry && filter.industry !== 'all') list = list.filter(s => s.industry === filter.industry);
  if (filter?.city)    list = list.filter(s => s.city?.toLowerCase().includes(filter.city.toLowerCase()));
  if (filter?.q)       list = list.filter(s => (s.name+s.desc+(s.tags||[]).join(' ')).toLowerCase().includes(filter.q.toLowerCase()));
  if (filter?.verified) list = list.filter(s => s.verified);
  return list;
}

function getSupplierById(id) {
  return SUPPLIERS.find(s => s.id === id) || fsRead('b2b_suppliers').find(s => s.id === id);
}

function registerSupplier(data) {
  const id = 'sup_' + Date.now();
  const sup = { id, ...data, verified: false, rating: 0, reviews: 0, createdAt: Date.now() };
  const arr = fsRead('b2b_suppliers');
  arr.unshift(sup);
  localStorage.setItem('b2b_b2b_suppliers', JSON.stringify(arr));
  fsWrite('b2b_suppliers', sup);
  return sup;
}

/* ══════════════════════════════════════════════
   PRODUCTS
══════════════════════════════════════════════ */
function getProducts(filter) {
  const extra = JSON.parse(localStorage.getItem('b2b_products')||'[]');
  let list = [...PRODUCTS, ...extra];
  if (filter?.category && filter.category !== 'all') list = list.filter(p => p.category === filter.category);
  if (filter?.supplierId) list = list.filter(p => p.supplierId === filter.supplierId);
  if (filter?.q) list = list.filter(p => (p.name+p.supplierName+(p.desc||'')).toLowerCase().includes(filter.q.toLowerCase()));
  return list;
}

function addProduct(data) {
  const id = 'wp_' + Date.now();
  const product = { id, ...data, createdAt: Date.now() };
  const arr = JSON.parse(localStorage.getItem('b2b_products')||'[]');
  arr.unshift(product);
  localStorage.setItem('b2b_products', JSON.stringify(arr));
  fsWrite('b2b_products', product);
  return product;
}

/* ══════════════════════════════════════════════
   RATINGS
══════════════════════════════════════════════ */
function saveRating(supplierId, rating, comment, orderId) {
  const key = 'b2b_ratings_' + supplierId;
  const arr = JSON.parse(localStorage.getItem(key)||'[]');
  arr.unshift({ id:'RT'+Date.now(), supplierId, rating, comment, orderId, ts: Date.now() });
  localStorage.setItem(key, JSON.stringify(arr.slice(0,100)));
  fsWrite('b2b_ratings', {supplierId, rating, comment, orderId, ts: Date.now()});
}

function getSupplierRating(supplierId) {
  const arr = JSON.parse(localStorage.getItem('b2b_ratings_'+supplierId)||'[]');
  if (!arr.length) {
    const sup = getSupplierById(supplierId);
    return { avg: sup?.rating || 4.5, count: sup?.reviews || 0 };
  }
  return { avg: (arr.reduce((s,r)=>s+r.rating,0)/arr.length).toFixed(1), count: arr.length };
}

/* ══════════════════════════════════════════════
   INVOICING
══════════════════════════════════════════════ */
function generateInvoice(orderId) {
  const order = getOrderById(orderId);
  if (!order) return null;
  const num = (parseInt(localStorage.getItem('b2b_inv_num')||'0') + 1);
  localStorage.setItem('b2b_inv_num', num);
  const inv = {
    id: 'BINV' + Date.now(),
    number: 'B2B-INV-' + String(num).padStart(4,'0'),
    orderId, order,
    status: 'unpaid',
    issuedAt: Date.now(),
    dueAt: Date.now() + 30*24*60*60*1000,
  };
  const arr = JSON.parse(localStorage.getItem('b2b_invoices')||'[]');
  arr.unshift(inv);
  localStorage.setItem('b2b_invoices', JSON.stringify(arr));
  fsWrite('b2b_invoices', inv);
  return inv;
}

function getInvoices() {
  return JSON.parse(localStorage.getItem('b2b_invoices')||'[]');
}

/* ══════════════════════════════════════════════
   ANALYTICS
══════════════════════════════════════════════ */
function getBuyerStats(uid) {
  const myRFQs   = getRFQs(uid);
  const myOrders = getOrders(uid);
  const myQuotes = myRFQs.flatMap(r => getQuotes(r.id));
  const totalSpent = myOrders.filter(o=>o.status==='delivered').reduce((s,o)=>s+(o.total||0),0);
  const activeSuppliers = new Set(myOrders.map(o=>o.supplierId)).size;
  return {
    rfqCount: myRFQs.length,
    openRFQs: myRFQs.filter(r=>r.status==='open').length,
    quoteCount: myQuotes.length,
    orderCount: myOrders.length,
    totalSpent,
    activeSuppliers,
    savingsEstimate: Math.round(totalSpent * 0.22),
  };
}

function getSupplierStats(supplierId) {
  const all = JSON.parse(localStorage.getItem('b2b_quotes')||'[]');
  const myQuotes = all.filter(q => q.supplierId === supplierId);
  const allOrders = getOrders();
  const myOrders = allOrders.filter(o => o.supplierId === supplierId);
  const revenue = myOrders.filter(o=>['delivered','confirmed'].includes(o.status)).reduce((s,o)=>s+(o.total||0),0);
  return {
    incomingRFQs: getRFQs().filter(r=>r.status==='open').length,
    quotesSubmitted: myQuotes.length,
    accepted: myQuotes.filter(q=>q.status==='accepted').length,
    orderCount: myOrders.length,
    revenue,
    winRate: myQuotes.length ? Math.round((myQuotes.filter(q=>q.status==='accepted').length/myQuotes.length)*100) : 0,
  };
}

/* ── Utils ── */
function fmt(n) { return Number(n||0).toLocaleString('en-KE'); }

function timeSince(ts) {
  const d = Date.now() - ts;
  const m = Math.floor(d/60000);
  if (m < 1) return 'Just now';
  if (m < 60) return m + ' min ago';
  if (m < 1440) return Math.floor(m/60) + 'h ago';
  return Math.floor(m/1440) + 'd ago';
}

function starsHTML(rating, small) {
  const s = small ? 'font-size:12px' : 'font-size:15px';
  return [1,2,3,4,5].map(i=>`<span style="${s};color:${i<=Math.round(rating)?'#f59e0b':'rgba(255,255,255,0.15)'}">★</span>`).join('');
}

function _getUid() {
  try { return JSON.parse(localStorage.getItem('sokoniUser')||'{}').uid || 'guest_' + Date.now(); } catch(e){ return 'guest'; }
}

function showToast(msg, type) {
  if(typeof window._sokoniToast==='function'){
    var t=type==='error'?'error':type==='warn'?'warning':'success';
    window._sokoniToast(msg,t,3000);return;
  }
  /* fallback */
  var old=document.getElementById('_b2bToast');if(old)old.remove();
  var el=document.createElement('div');el.id='_b2bToast';
  var c=type==='error'?'#ef4444':type==='warn'?'#f59e0b':'#71ff00';
  el.style.cssText='position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:'+c+';color:'+(type?'white':'black')+';padding:10px 22px;border-radius:12px;font-weight:900;font-size:13px;z-index:99999;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,0.4);pointer-events:none;transition:opacity .3s;';
  el.textContent=msg;document.body.appendChild(el);
  setTimeout(function(){el.style.opacity='0';setTimeout(function(){if(el.parentNode)el.remove();},300);},3000);
}

/* ── Public API ── */
window.SokoniB2B = {
  /* Data */
  SUPPLIERS, PRODUCTS, INDUSTRIES, SUPPLIER_TYPES, CAT_ICONS,
  RFQ_STATUS, QUOTE_STATUS, ORDER_STATUS,
  /* RFQ */
  createRFQ, getRFQs, getRFQById, updateRFQStatus, deleteRFQ,
  /* Quotes */
  submitQuote, getQuotes, getAllQuotes: getQuotes, getQuoteById, updateQuoteStatus, acceptQuote,
  /* Orders */
  createOrder, getOrders, getOrderById, updateOrderStatus,
  /* Messaging */
  sendMessage, getMessages, getThreads, markThreadRead,
  /* Notifications */
  addNotification, getNotifications, markNotifsRead, getUnreadCount,
  /* Suppliers */
  getSuppliers, getSupplierById, registerSupplier,
  /* Products */
  getProducts, addProduct, getProductsBySupplierId: (id) => getProducts({supplierId: id}),
  /* Ratings */
  saveRating, getSupplierRating,
  /* Invoicing */
  generateInvoice, getInvoices,
  /* Analytics */
  getBuyerStats, getSupplierStats,
  /* Utils */
  fmt, timeSince, starsHTML, showToast,
};

})();
