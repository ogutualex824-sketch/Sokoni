/* sokoni-marketing.js — Marketing Hub data + Firestore layer v1.0 */
(function(global){
'use strict';

const MKT = {};

MKT.ACCENT = '#fb923c';

MKT.CATEGORIES = [
  { id:'all',           icon:'⚡', label:'All Services',   color:'#fb923c', desc:'Browse all marketing services' },
  { id:'advertising',   icon:'📢', label:'Advertising',    color:'#f97316', desc:'Sponsored listings, banners, featured placements',
    services:['Sponsored Listings','Featured Business','Banner Advertising','Homepage Promotions','Hub Promotions','Category Spotlight','Premium Placement','Retargeting Ads'] },
  { id:'social',        icon:'📱', label:'Social Media',   color:'#8b5cf6', desc:'Facebook, Instagram, TikTok, YouTube, LinkedIn',
    services:['Facebook Marketing','Instagram Marketing','TikTok Marketing','YouTube Marketing','LinkedIn Marketing','Twitter/X Marketing','Social Media Management','Community Building'] },
  { id:'creative',      icon:'🎨', label:'Creative',       color:'#ec4899', desc:'Design, photography, videography, branding',
    services:['Graphic Design','Logo Design','Branding & Identity','Product Photography','Videography','Video Editing','Content Creation','Flyer Design','Social Media Graphics'] },
  { id:'content',       icon:'✍️', label:'Content',        color:'#14b8a6', desc:'Copywriting, blogs, SEO content, press releases',
    services:['Copywriting','Blog Writing','SEO Content','Product Descriptions','Press Releases','Email Templates','Sales Scripts','Article Writing'] },
  { id:'seo',           icon:'🔍', label:'SEO',            color:'#3b82f6', desc:'Website SEO, local SEO, Google Business',
    services:['Website SEO','Local SEO','Google Business Optimization','Keyword Research','Backlink Building','Technical SEO Audit','Site Speed Optimization','Schema Markup'] },
  { id:'growth',        icon:'📈', label:'Growth Tools',   color:'#10b981', desc:'Email, SMS, WhatsApp, marketing automation',
    services:['Email Marketing','SMS Marketing','WhatsApp Marketing','Marketing Automation','CRM Setup','Lead Generation','Funnel Building','Referral Programs'] },
  { id:'professionals', icon:'👥', label:'Professionals',  color:'#eab308', desc:'Agencies, freelancers, consultants, influencers',
    services:['Marketing Agencies','Freelancers','Consultants','Influencers','Brand Ambassadors','PR Specialists','Event Marketers','Photographers'] },
  { id:'analytics',     icon:'📊', label:'Analytics',      color:'#6366f1', desc:'Campaign tracking, lead tracking, reports',
    services:['Campaign Tracking','Lead Tracking','Conversion Reports','Marketing Dashboards','A/B Testing','ROI Analysis','Audience Insights','Competitor Analysis'] },
];

MKT.PROVIDERS = [
  {
    id:'p001', name:'BrandCraft Agency', initials:'BC', color:'#f97316',
    category:'advertising', badge:'Featured',
    services:['Sponsored Listings','Featured Business','Banner Advertising','Homepage Promotions'],
    rating:4.9, reviews:87, priceFrom:2500, location:'Nairobi CBD',
    verified:true, featured:true,
    bio:'Full-service advertising agency with 5+ years helping Kenyan businesses get maximum visibility. Specialists in SOKONI platform advertising and digital campaign management.',
    portfolio:['📊 Campaign Analytics','🎯 Targeted Placement Ads','📱 Social Amplification','🏠 Homepage Banners'],
    responseTime:'< 2 hrs', completedJobs:142,
  },
  {
    id:'p002', name:'Social Wave KE', initials:'SW', color:'#8b5cf6',
    category:'social', badge:'Top Rated',
    services:['Instagram Marketing','TikTok Marketing','Facebook Marketing','Social Media Management'],
    rating:4.8, reviews:63, priceFrom:3000, location:'Westlands, Nairobi',
    verified:true, featured:false,
    bio:'Expert social media team managing accounts for 50+ Kenyan businesses. Viral content specialists for TikTok and Instagram Reels. Proven 10x follower growth.',
    portfolio:['📸 Instagram Growth','🎵 TikTok Viral Campaigns','📘 Facebook ROAS Optimization','📈 Follower Growth Reports'],
    responseTime:'< 1 hr', completedJobs:98,
  },
  {
    id:'p003', name:'Pixel Studio', initials:'PS', color:'#ec4899',
    category:'creative', badge:'Featured',
    services:['Graphic Design','Logo Design','Branding & Identity','Product Photography'],
    rating:4.9, reviews:115, priceFrom:1500, location:'Kilimani, Nairobi',
    verified:true, featured:true,
    bio:'Award-winning creative studio. From logos to full brand identities. Product photography optimized for e-commerce. Trusted by 100+ brands.',
    portfolio:['🖼️ Brand Identity Packages','📷 Product Photos','🎨 Print & Digital Design','✨ Packaging Design'],
    responseTime:'< 3 hrs', completedJobs:200,
  },
  {
    id:'p004', name:'ContentPro Kenya', initials:'CP', color:'#14b8a6',
    category:'content', badge:'Verified',
    services:['Copywriting','Blog Writing','SEO Content','Product Descriptions','Press Releases'],
    rating:4.7, reviews:44, priceFrom:800, location:'Mombasa',
    verified:true, featured:false,
    bio:'SEO-focused content writers creating compelling copy for e-commerce, blogs, and social media. Fluent in English and Swahili. Fast turnaround guaranteed.',
    portfolio:['📝 Blog Strategy & Writing','🛍️ E-commerce Product Copy','📧 Email Campaign Series','📰 Press Release Distribution'],
    responseTime:'< 4 hrs', completedJobs:75,
  },
  {
    id:'p005', name:'RankUp Digital', initials:'RU', color:'#3b82f6',
    category:'seo', badge:'Top Rated',
    services:['Website SEO','Local SEO','Google Business Optimization','Keyword Research'],
    rating:4.8, reviews:52, priceFrom:4000, location:'Upperhill, Nairobi',
    verified:true, featured:false,
    bio:'Certified Google SEO specialists helping Kenyan businesses rank #1. Local SEO experts. Google Business Profile optimizations that drive foot traffic and calls.',
    portfolio:['🔍 Keyword Strategy Reports','📈 Rank Tracking Dashboards','📍 Google Maps Optimization','🏆 Page 1 Case Studies'],
    responseTime:'< 2 hrs', completedJobs:88,
  },
  {
    id:'p006', name:'GrowthHive KE', initials:'GH', color:'#10b981',
    category:'growth', badge:'Featured',
    services:['Email Marketing','SMS Marketing','WhatsApp Marketing','Marketing Automation'],
    rating:4.9, reviews:71, priceFrom:2000, location:'Karen, Nairobi',
    verified:true, featured:true,
    bio:'Marketing automation specialists. Set up email funnels, WhatsApp drip campaigns, and SMS blasts. We build systems that sell 24/7 while you sleep.',
    portfolio:['📧 Email Funnels (5-step)','💬 WhatsApp Broadcast Campaigns','📲 Bulk SMS Delivery','⚙️ Automation Workflows'],
    responseTime:'< 1 hr', completedJobs:120,
  },
  {
    id:'p007', name:'Influencer Hub KE', initials:'IH', color:'#eab308',
    category:'professionals', badge:'Verified',
    services:['Influencers','Brand Ambassadors','PR Specialists'],
    rating:4.6, reviews:38, priceFrom:5000, location:'Nairobi',
    verified:true, featured:false,
    bio:'Connect with verified Kenyan influencers across Instagram, TikTok, and YouTube. Nano to mega influencers. Full campaign management and performance reporting.',
    portfolio:['🤳 Nano Influencer Networks','🎬 YouTube Product Reviews','📸 Instagram Story Campaigns','📊 Influencer ROI Reports'],
    responseTime:'< 3 hrs', completedJobs:55,
  },
  {
    id:'p008', name:'DataPulse Analytics', initials:'DA', color:'#6366f1',
    category:'analytics', badge:'Verified',
    services:['Campaign Tracking','Lead Tracking','Conversion Reports','Marketing Dashboards'],
    rating:4.8, reviews:29, priceFrom:3500, location:'Nairobi',
    verified:true, featured:false,
    bio:'Data-driven marketing analytics for Kenyan businesses. Custom dashboards, campaign ROI reports, and conversion optimization. We turn data into growth decisions.',
    portfolio:['📊 Custom Marketing Dashboards','🎯 Conversion Funnel Analysis','📈 Monthly ROI Reports','🔬 A/B Test Results'],
    responseTime:'< 2 hrs', completedJobs:40,
  },
  {
    id:'p009', name:'Mwangi Creative', initials:'MC', color:'#f43f5e',
    category:'creative', badge:'Featured',
    services:['Videography','Video Editing','Content Creation','Social Media Graphics'],
    rating:4.9, reviews:93, priceFrom:2000, location:'Nairobi',
    verified:true, featured:true,
    bio:'Professional videographer and content creator. Product demo videos, brand films, and social media reels. Films that convert viewers into buyers.',
    portfolio:['🎬 Brand Films & Documentaries','📱 Social Media Reels','📹 Product Demo Videos','✂️ Professional Editing'],
    responseTime:'< 2 hrs', completedJobs:155,
  },
  {
    id:'p010', name:'TechSEO Pro', initials:'TP', color:'#06b6d4',
    category:'seo', badge:'Verified',
    services:['Technical SEO Audit','Backlink Building','Website SEO','Site Speed Optimization'],
    rating:4.7, reviews:35, priceFrom:5000, location:'Nairobi',
    verified:true, featured:false,
    bio:'Technical SEO specialists. Full site audits, page speed optimization, schema markup implementation, and white-hat link building for sustainable rankings.',
    portfolio:['⚙️ Technical SEO Audits','🔗 Authority Link Building','🚀 Core Web Vitals Optimization','📋 Structured Data Setup'],
    responseTime:'< 4 hrs', completedJobs:60,
  },
  {
    id:'p011', name:'Faida Consultants', initials:'FC', color:'#a855f7',
    category:'professionals', badge:'Top Rated',
    services:['Marketing Agencies','Consultants','Freelancers'],
    rating:4.8, reviews:67, priceFrom:1500, location:'Nairobi & Kisumu',
    verified:true, featured:false,
    bio:'End-to-end marketing consultancy for SMEs and startups across Kenya. We craft strategies, execute campaigns, and measure results. Strategy to execution in one team.',
    portfolio:['📋 Marketing Strategy Plans','📊 Market Research Reports','🎯 Campaign Execution','💼 Business Growth Roadmaps'],
    responseTime:'< 2 hrs', completedJobs:110,
  },
  {
    id:'p012', name:'Ad Boost Kenya', initials:'AB', color:'#fb923c',
    category:'advertising', badge:'Verified',
    services:['Hub Promotions','Category Spotlight','Premium Placement','Retargeting Ads'],
    rating:4.7, reviews:48, priceFrom:1000, location:'Nairobi',
    verified:true, featured:false,
    bio:'Specialist in SOKONI platform promotions. Get your business on the homepage, featured in category pages, and in hub spotlights. Maximum visibility guaranteed.',
    portfolio:['🏠 Homepage Banners','📌 Category Feature Placements','⭐ Hub Spotlight Campaigns','🔁 Retargeting Campaigns'],
    responseTime:'< 1 hr', completedJobs:85,
  },
];

MKT.SERVICES_GRID = [
  { icon:'📢', title:'Sponsored Listings',    cat:'advertising',   price:'From KES 500' },
  { icon:'📱', title:'Social Media Marketing', cat:'social',        price:'From KES 3,000' },
  { icon:'🎨', title:'Graphic Design',         cat:'creative',      price:'From KES 1,500' },
  { icon:'✍️', title:'SEO Content Writing',    cat:'content',       price:'From KES 800' },
  { icon:'🔍', title:'Website SEO',            cat:'seo',           price:'From KES 4,000' },
  { icon:'📧', title:'Email Marketing',        cat:'growth',        price:'From KES 2,000' },
  { icon:'🎬', title:'Video Production',       cat:'creative',      price:'From KES 2,000' },
  { icon:'📊', title:'Marketing Analytics',    cat:'analytics',     price:'From KES 3,500' },
  { icon:'🤳', title:'Influencer Marketing',   cat:'professionals', price:'From KES 5,000' },
  { icon:'💬', title:'WhatsApp Marketing',     cat:'growth',        price:'From KES 1,500' },
  { icon:'📷', title:'Product Photography',    cat:'creative',      price:'From KES 2,500' },
  { icon:'🔗', title:'Link Building',          cat:'seo',           price:'From KES 3,000' },
];

// ---- Utilities ----
MKT.esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
MKT.fmt = n => n >= 1000 ? `${(n/1000).toFixed(n%1000===0?0:1)}K` : String(n);
MKT.getCat = id => MKT.CATEGORIES.find(c => c.id === id);
MKT.getProviders = (catId, search) => {
  let list = [...MKT.PROVIDERS];
  if (catId && catId !== 'all') list = list.filter(p => p.category === catId);
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.services.some(s => s.toLowerCase().includes(q)) ||
      p.location.toLowerCase().includes(q) ||
      (MKT.getCat(p.category)||{}).label?.toLowerCase().includes(q)
    );
  }
  return list.sort((a,b) => (b.featured?1:0)-(a.featured?1:0) || b.rating-a.rating);
};
MKT.getProvider = id => MKT.PROVIDERS.find(p => p.id === id);
MKT.stars = r => '★'.repeat(Math.floor(r)) + (r%1>=0.5?'½':'') + '☆'.repeat(5-Math.ceil(r));

// ---- Firestore: save booking/quote ----
MKT.saveBooking = async data => {
  try {
    const {collection,addDoc,serverTimestamp}=await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const db=window.firebaseDB;
    if(!db) return {id:'local-'+Date.now()};
    const ref=await addDoc(collection(db,'marketingBookings'),{...data,status:'pending',createdAt:serverTimestamp()});
    return {id:ref.id};
  } catch(e){return {id:'local-'+Date.now()};}
};

// ---- Firestore: load real providers (supplements mock data) ----
MKT.loadFirestoreProviders = async () => {
  try {
    const {collection,query,where,orderBy,limit,getDocs}=await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const db=window.firebaseDB;
    if(!db) return;
    const snap=await getDocs(query(collection(db,'marketingProviders'),where('active','==',true),orderBy('createdAt','desc'),limit(40)));
    snap.forEach(doc=>{
      if(!MKT.PROVIDERS.find(p=>p.id===doc.id))
        MKT.PROVIDERS.push({id:doc.id,...doc.data(),_fs:true});
    });
  } catch(e){}
};

global.MKT = MKT;
})(window);
