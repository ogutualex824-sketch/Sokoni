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

/* == SUPPLIER DIRECTORY =====================================================
   INTENTIONALLY EMPTY. This array previously shipped invented Kenyan businesses:
   names, phone numbers, ratings, review counts, founding years, minimum order values
   and ISO / KEBS / GlobalGAP certification claims, rendered as a live supplier
   directory on a page linked from the homepage. None of it was backed by any query.
   There was no request to fail, because the invented data WAS the data.

   The canonical supplier surfaces are server-side and business-scoped:
     procurement.findSuppliers       discovery over businesses that opted in (Slice K)
     procurement.getSupplyCatalogue  a business real wholesale offers        (Slice L)

   Do not repopulate this with literals. A truthful empty directory is correct; an
   invented one is the defect this file is named in.
   See docs/DEFECT_FABRICATED_B2B_CATALOGUE.md.
   ========================================================================== */
const SUPPLIERS = [];

/* == PRODUCT CATALOG ========================================================
   INTENTIONALLY EMPTY, for the same reason. This array shipped invented wholesale
   rows carrying invented prices, minimum order quantities and savings percentages.
   A fabricated MOQ is a term of trade no supplier agreed to, and a fabricated
   saving is a financial claim. Real wholesale terms live on the product itself
   (wholesalePrice / minWholesaleQty) and are read through the canonical
   procurement.getSupplyCatalogue, never from a client-side literal.
   ========================================================================== */
const PRODUCTS = [];

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
  /* rating is NULL, not 0. A newly registered supplier has not been rated; zero reads as
     "rated badly" and is an invented judgement about a real business. reviews:0 is a true
     count. verified:false is a true absence of a claim. */
  const sup = { id, ...data, verified: false, rating: null, reviews: 0, createdAt: Date.now() };
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
