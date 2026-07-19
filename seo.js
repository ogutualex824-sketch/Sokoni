/**
 * SOKONI SEO ENGINE
 * Injects dynamic meta tags, Open Graph, Schema.org JSON-LD and Google rich results
 * on every page. Include this script in <head> on every page.
 *
 * Usage:
 *   SokoniSEO.init();                            // auto-detects page from URL
 *   SokoniSEO.setProduct(productObj);            // call from product pages
 *   SokoniSEO.setService(serviceObj);            // call from service pages
 *   SokoniSEO.setListing(listingObj, 'rental');  // call from property/bnb pages
 */

const SokoniSEO = (() => {

  /* ── Core brand info ──
     legalName is sourced from the canonical CompanyIdentity service
     (window.SOKONI_COMPANY, from sokoni-company.js) so the legal entity is not
     duplicated; the literal is only a resilience fallback if that script hasn't
     loaded yet. (The detailed SEO address below is a richer superset that can be
     folded into CompanyIdentity once the verified registered/postal address is set.) */
  const _CO = (typeof window !== 'undefined' && window.SOKONI_COMPANY) || {};
  const BRAND = {
    name:        _CO.brand || "SOKONI",
    legalName:   _CO.legalName || "Bravilex International Co. Limited",
    url:         "https://mysokoni.co.ke",
    logo:        "https://mysokoni.co.ke/assets/logosokoni.png",
    description: "Kenya's all-in-one marketplace — shop products, book services, find rentals, BnBs, healthcare, entertainment and B2B wholesale. Pay via M-Pesa.",
    phone:       "+254705726803",
    email:       "info@sokoni.co.ke",
    address: {
      streetAddress: "Westlands",
      addressLocality: "Nairobi",
      addressRegion:   "Nairobi County",
      postalCode:      "00100",
      addressCountry:  "KE"
    },
    sameAs: [
      "https://wa.me/254705726803",
      "https://mysokoni.co.ke"
    ],
    keywords: "SOKONI, mysokoni, online shopping kenya, buy online kenya, services nairobi, services kenya, plumber nairobi, electrician nairobi, m-pesa payment kenya, wholesale kenya, bnb nairobi, house for rent nairobi, healthcare kenya, marketplace kenya, online market kenya, sokoni kenya, sokoni marketplace"
  };

  /* Pages that must never be indexed — seo.js skips robots injection for these */
  const NOINDEX_PAGES = new Set([
    "monitor.html", "admin.html", "verification-admin.html",
    "test-accounts.html", "inspiq.html", "test-smoke.html",
    "seller-analytics.html", "seller-revenue.html",
    "growth-dashboard.html", "business-analytics.html",
    "customer-analytics.html",
  ]);

  /* ── Page configs — every public page ── */
  const PAGE_CONFIGS = {
    "index.html":         { title:"SOKONI — Kenya's Online Marketplace | Shop, Services, Rentals, Healthcare & More", desc:"SOKONI is Kenya's all-in-one marketplace. Buy products, book plumbers, electricians & cleaners, find BnBs, houses for rent, healthcare and entertainment. Pay with M-Pesa.", type:"WebSite", kw:"sokoni, mysokoni kenya, online shopping nairobi, buy online kenya, m-pesa marketplace" },
    "category.html":      { title:"Shop Online in Kenya — Fashion, Electronics, Beauty & More | SOKONI", desc:"Browse thousands of products: fashion, electronics, phones, beauty, food, furniture and more from verified Kenyan sellers. Fast delivery across Kenya. Pay via M-Pesa.", type:"CollectionPage", kw:"online shopping kenya, buy products nairobi, electronics kenya, fashion kenya" },
    "services.html":      { title:"Book Local Services in Kenya — Plumbers, Electricians, Cleaners | SOKONI", desc:"Find and hire verified plumbers, electricians, cleaners, mechanics, barbers, tutors and 30+ other service providers in Nairobi, Mombasa, Kisumu. Pay via M-Pesa.", type:"Service", kw:"hire plumber nairobi, electrician nairobi, cleaner nairobi, book services kenya, handyman nairobi" },
    "healthcare.html":    { title:"Book a Doctor in Kenya — Hospitals, Clinics & Pharmacies | SOKONI", desc:"Find hospitals, clinics, dentists, pharmacies and labs in Nairobi, Mombasa and across Kenya. Book appointments online, order medicine delivered to your door.", type:"MedicalOrganization", kw:"book doctor nairobi, hospitals nairobi, pharmacy kenya, medical appointment kenya, online doctor kenya" },
    "property.html":      { title:"Houses & Apartments for Rent in Kenya | Bedsitters, 1BR, 2BR | SOKONI", desc:"Find bedsitters, studios, 1BR, 2BR and 3BR apartments and offices for rent in Nairobi, Mombasa, Kisumu and across Kenya. Contact landlords directly — no agent fees.", type:"RealEstateListing", kw:"house for rent nairobi, apartment rent kenya, bedsitter nairobi, 1 bedroom nairobi, rent house kenya" },
    "bnb.html":           { title:"BnB & Short Stay in Kenya — Nairobi, Mombasa, Kisumu | SOKONI", desc:"Book affordable BnBs, self-contained apartments, hotel rooms and villas in Nairobi, Mombasa, Kisumu and across Kenya. Pay with M-Pesa. Instant confirmation.", type:"LodgingBusiness", kw:"bnb nairobi, airbnb kenya, short stay nairobi, accommodation kenya, guest house nairobi" },
    "b2b.html":           { title:"B2B Wholesale Kenya — Buy in Bulk from Verified Suppliers | SOKONI", desc:"Connect with KRA-registered Kenyan suppliers and manufacturers. Get wholesale prices, post bulk purchase requests, find distributors across Kenya.", type:"Store", kw:"wholesale kenya, b2b kenya, bulk buying nairobi, supplier kenya, manufacturer kenya, wholesale nairobi" },
    "legal-hub.html":     { title:"Find a Lawyer in Kenya — Legal Help & Court Documents | SOKONI", desc:"Connect with verified Kenyan advocates. Get demand letters, affidavits, NDAs, sale agreements and court documents drafted. Know your rights under Kenyan law.", type:"LegalService", kw:"lawyer nairobi, advocate kenya, legal help nairobi, court documents kenya, legal advice kenya" },
    "legal.html":         { title:"Legal Services & Documents Kenya | SOKONI", desc:"Get legal documents drafted, find advocates and understand your rights under Kenyan law. Demand letters, NDAs, tenancy agreements and more.", type:"LegalService", kw:"legal documents kenya, lawyer kenya, court help nairobi, tenancy agreement kenya" },
    "flashsale.html":     { title:"Flash Sales & Hot Deals Kenya — Up to 70% Off | SOKONI", desc:"Don't miss SOKONI Kenya's daily flash sales. Huge discounts on electronics, fashion, beauty and more. Limited stock — pay with M-Pesa instantly.", type:"SaleEvent", kw:"flash sale kenya, deals nairobi, discounts kenya, cheap phones kenya, cheap shopping kenya" },
    "entertainment.html": { title:"Book DJs, MCs, Bands & Event Entertainment in Kenya | SOKONI", desc:"Book top DJs, MCs, live bands, comedians, dancers and photographers for weddings, corporate events and parties in Nairobi, Mombasa and across Kenya.", type:"EntertainmentBusiness", kw:"dj nairobi hire, mc kenya, live band nairobi, wedding entertainment kenya, event planner nairobi" },
    "community.html":     { title:"SOKONI Community — Kenya's Buyer & Seller Forum", desc:"Connect with thousands of Kenyan buyers and sellers. Share deals, ask questions, get recommendations and buy & sell in the SOKONI community.", type:"CommunityForum", kw:"online community kenya, buyer seller forum kenya, deals kenya, marketplace community" },
    "digital.html":       { title:"Digital Services Kenya — Web Design, SEO, Graphic Design | SOKONI", desc:"Hire verified Kenyan digital professionals for web design, graphic design, social media management, SEO, app development and more. Remote or onsite.", type:"Service", kw:"web design kenya, graphic design nairobi, seo kenya, digital marketing kenya, app developer kenya" },
    "loyalty.html":       { title:"SOKONI Loyalty Points — Earn & Redeem on Every Purchase", desc:"Earn Sokoni Points on every order and service booking. Redeem for discounts, free delivery and exclusive member perks. The more you shop, the more you save.", type:"LoyaltyProgram", kw:"loyalty programme kenya, rewards shopping kenya, sokoni points, cashback kenya" },
    "driver.html":        { title:"Become a Delivery Driver in Kenya — Earn with SOKONI | SOKONI", desc:"Join SOKONI as a delivery rider or driver in Nairobi, Mombasa or Kisumu. Fair pay — 88% per delivery. Boda boda, e-bike, car, van and pickup riders welcome.", type:"Service", kw:"delivery driver nairobi, boda boda jobs kenya, rider job nairobi, delivery job kenya, earn riding kenya" },
    "food.html":          { title:"Order Food Online in Kenya — Restaurants, Fast Food & Catering | SOKONI", desc:"Order food from restaurants, fast food chains and caterers in Nairobi, Mombasa and across Kenya. Home delivery and catering for events. Pay with M-Pesa.", type:"FoodEstablishment", kw:"food delivery nairobi, order food kenya, restaurant nairobi, catering kenya, food online kenya" },
    "car-hub.html":       { title:"Cars, Car Hire & NTSA Services in Kenya | SOKONI Car Hub", desc:"Hire a car in Kenya, check NTSA services, driving licence renewal, insurance quotes, GPS tracking and find garages near you. All car services on SOKONI.", type:"AutoDealer", kw:"car hire kenya, rent a car nairobi, NTSA services kenya, driving licence renewal kenya, car insurance kenya" },
    "car-rental.html":    { title:"Car Rental in Kenya — Hire Cars in Nairobi & Across Kenya | SOKONI", desc:"Rent economy cars, SUVs, vans and minibuses in Nairobi, Mombasa, Kisumu and across Kenya. Self-drive and chauffeur-driven options. Pay with M-Pesa.", type:"AutoRental", kw:"car rental nairobi, hire car kenya, self drive kenya, rent suv nairobi, car hire mombasa" },
    "sports-hub.html":    { title:"Book Sports Facilities & Coaches in Kenya | SOKONI", desc:"Book football pitches, gyms, swimming pools, courts and sports coaches in Nairobi, Mombasa and across Kenya. Pay with M-Pesa.", type:"SportsActivityLocation", kw:"football pitch nairobi, gym kenya, sports coach nairobi, swimming pool nairobi, sports booking kenya" },
    "banking.html":       { title:"Banking & Finance Services in Kenya | SOKONI", desc:"Compare bank accounts, mobile loans, insurance products and investment options from Kenyan banks and SACCOs. Financial services on SOKONI.", type:"FinancialService", kw:"banking kenya, mobile loan kenya, insurance kenya, sacco kenya, financial services nairobi" },
    "marketing.html":     { title:"Market Your Business in Kenya — Social Media, SEO & Ads | SOKONI", desc:"Promote your SOKONI store with boost packages, social media tools and analytics. Reach more buyers across Kenya.", type:"Service", kw:"marketing kenya, social media marketing nairobi, boost business kenya, seo nairobi" },
    "construction.html":  { title:"Find Contractors & Construction Services in Kenya | SOKONI", desc:"Hire verified builders, contractors, architects and construction workers in Nairobi, Mombasa and across Kenya. Get quotes for your project.", type:"HomeAndConstructionBusiness", kw:"contractor nairobi, builder kenya, construction company kenya, architect nairobi, building contractor kenya" },
    "cleaning.html":      { title:"Book Professional Cleaners in Kenya — Home & Office | SOKONI", desc:"Hire professional house cleaners, office cleaning services and laundry providers in Nairobi, Mombasa and across Kenya. Book online, pay with M-Pesa.", type:"Service", kw:"house cleaner nairobi, cleaning service kenya, office cleaning nairobi, laundry service kenya" },
    "electrical.html":    { title:"Hire an Electrician in Kenya — Home & Solar Installations | SOKONI", desc:"Find verified electricians for wiring, repairs, CCTV installation and solar system setup in Nairobi, Mombasa and across Kenya. Pay with M-Pesa.", type:"Service", kw:"electrician nairobi, electrical repair kenya, solar installation kenya, wiring nairobi, cctv installation kenya" },
    "plumbing.html":      { title:"Find a Plumber in Kenya — Nairobi, Mombasa & Countrywide | SOKONI", desc:"Book verified plumbers for leak repairs, pipe installation, bathroom fitting and emergency plumbing in Nairobi, Mombasa and across Kenya.", type:"Service", kw:"plumber nairobi, plumbing kenya, leak repair nairobi, bathroom fitting kenya, emergency plumber kenya" },
    "mechanics.html":     { title:"Find a Mechanic in Kenya — Car Repairs & Garages | SOKONI", desc:"Find trusted mechanics and garages in Nairobi, Mombasa and across Kenya. Oil changes, brake repairs, diagnostics and full engine overhauls.", type:"AutomotiveBusiness", kw:"mechanic nairobi, garage kenya, car repair nairobi, oil change kenya, auto repair kenya" },
    "phone-repair.html":  { title:"Phone & Laptop Repair in Kenya — Screen, Battery & More | SOKONI", desc:"Fix your phone or laptop in Kenya. Screen replacement, battery swap, data recovery, software unlock and hardware repair in Nairobi and across Kenya.", type:"ElectronicsStore", kw:"phone repair nairobi, screen replacement kenya, laptop repair kenya, iphone repair nairobi, samsung repair kenya" },
    "delivery.html":      { title:"Delivery Services in Kenya — Same Day, CBD & Countrywide | SOKONI", desc:"Send packages and parcels across Nairobi same day or countrywide. Trusted riders, live tracking, M-Pesa payment. For businesses and individuals.", type:"Service", kw:"delivery service nairobi, courier kenya, same day delivery nairobi, parcel delivery kenya, logistics kenya" },
    "inspiq.html":        { title:"SOKONI InspIQ — AI Product Discovery & Deal Finder Kenya", desc:"Discover the best products and deals in Kenya with SOKONI InspIQ. AI-powered recommendations tailored to your style and budget.", type:"WebApplication", kw:"product discovery kenya, ai shopping kenya, best deals nairobi, recommendations kenya" },
    "offer.html":         { title:"Special Offers & Promotions in Kenya | SOKONI", desc:"Exclusive deals, bundle offers and seasonal promotions from verified sellers across Kenya. Save more when you buy on SOKONI.", type:"Offer", kw:"offers kenya, promotions nairobi, deals kenya, discount shopping kenya" },
    "referral.html":      { title:"Refer & Earn with SOKONI Kenya — Get KES 200 Per Referral", desc:"Invite your friends to shop on SOKONI Kenya and earn KES 200 for every successful referral. The more you share, the more you earn.", type:"Service", kw:"referral program kenya, earn money kenya, refer friend kenya, sokoni referral" },
    "requests.html":      { title:"Post a Buyer Request — Find What You Need in Kenya | SOKONI", desc:"Can't find what you're looking for? Post a buyer request on SOKONI and let verified Kenyan sellers come to you with their best offers.", type:"Service", kw:"buyer request kenya, find product kenya, buy anything kenya, custom order kenya" },
    "reviews.html":       { title:"Product & Seller Reviews Kenya | SOKONI", desc:"Read honest reviews from verified Kenyan buyers. Rate products, sellers and service providers on SOKONI to help others shop smarter.", type:"Review", kw:"product reviews kenya, seller ratings kenya, trusted sellers kenya, verified reviews kenya" },
    "store.html":         { title:"SOKONI Store — Shop from Verified Kenyan Sellers", desc:"Browse and shop from verified Kenyan seller stores. Thousands of products across all categories with buyer protection and M-Pesa payment.", type:"Store", kw:"online store kenya, kenyan seller, verified shop kenya, buy from seller kenya" },
    "product.html":       { title:"Buy Products Online in Kenya — Fast Delivery | SOKONI", desc:"Shop quality products from verified Kenyan sellers with buyer protection. Fast delivery nationwide. Pay with M-Pesa, Visa or Mastercard.", type:"Product", kw:"buy product kenya, online shop nairobi, product nairobi, buy online m-pesa kenya" },
    "track.html":         { title:"Track Your Order — SOKONI Kenya Real-Time Delivery Tracking", desc:"Track your SOKONI order in real time. See your rider's live location, delivery status and estimated arrival time. Nationwide delivery tracking.", type:"Service", kw:"track order kenya, delivery tracking nairobi, order status kenya, live tracking kenya" },
    "subscriptions.html": { title:"SOKONI Subscription Plans — Seller & Business Tools Kenya", desc:"Upgrade your SOKONI seller account with subscription plans. Get more visibility, analytics, priority support and advanced selling tools.", type:"Service", kw:"seller subscription kenya, business plan kenya, sokoni pro, seller tools kenya" },
    "ministore.html":     { title:"Quick Shop — SOKONI Mini Store Kenya", desc:"Quick purchase from SOKONI's curated mini store. Top products, fast checkout and M-Pesa payment. Shop in seconds.", type:"Store", kw:"quick shop kenya, mini store kenya, fast buy kenya, easy shopping kenya" },
    "dispute.html":       { title:"Report an Issue — SOKONI Buyer Protection Kenya", desc:"Raise a dispute, report a problem or request a refund on SOKONI. Our buyer protection team resolves issues within 24 hours.", type:"CustomerService", kw:"refund kenya, dispute kenya, buyer protection, complaint kenya, sokoni support" },
    "unboxing.html":      { title:"Product Unboxing & Reviews — SOKONI Kenya", desc:"Watch unboxing videos and read real reviews from verified buyers before you shop. See exactly what you're getting before you buy on SOKONI.", type:"VideoObject", kw:"unboxing kenya, product review kenya, buy review kenya, sokoni unboxing" },
    "signup.html":        { title:"Create Your SOKONI Account — Shop & Sell in Kenya", desc:"Sign up free on SOKONI Kenya. Join thousands of buyers and sellers. Shop products, book services and sell anything — all with M-Pesa.", type:"WebPage", kw:"register sokoni, create account kenya, join sokoni, sign up kenya marketplace" },
    "login.html":         { title:"Log In to SOKONI — Kenya's Online Marketplace", desc:"Log in to your SOKONI account to shop, sell, track orders and manage your services in Kenya.", type:"WebPage", kw:"sokoni login, sign in kenya, marketplace login kenya" },
  };

  /* ─── Helpers ─── */
  function getPageKey(){
    const path = window.location.pathname;
    const file = path.split("/").pop() || "index.html";
    return file.split("?")[0] || "index.html";
  }

  function setMeta(name, content, isOg){
    if(!content) return;
    const attr    = isOg ? "property" : "name";
    let   el      = document.querySelector(`meta[${attr}="${name}"]`);
    if(!el){ el = document.createElement("meta"); el.setAttribute(attr, name); document.head.appendChild(el); }
    el.setAttribute("content", content);
  }

  function setLink(rel, href){
    let el = document.querySelector(`link[rel="${rel}"]`);
    if(!el){ el = document.createElement("link"); el.setAttribute("rel", rel); document.head.appendChild(el); }
    el.setAttribute("href", href);
  }

  function injectSchema(schemaObj){
    const id = "schema-" + schemaObj["@type"];
    let el = document.getElementById(id);
    if(!el){ el = document.createElement("script"); el.type = "application/ld+json"; el.id = id; document.head.appendChild(el); }
    el.textContent = JSON.stringify(schemaObj, null, 2);
  }

  function removeSchema(type){
    const el = document.getElementById("schema-"+type);
    if(el) el.remove();
  }

  /* ─── Core page SEO ─── */
  function init(){
    const key    = getPageKey();
    const cfg    = PAGE_CONFIGS[key] || { title:"SOKONI — Kenya's Online Marketplace", desc:BRAND.description };
    const title  = cfg.title;
    const desc   = cfg.desc;
    const url    = BRAND.url + "/" + (key === "" ? "" : key);
    const image  = BRAND.logo;

    /* ── Title ── */
    document.title = title;

    /* ── Standard meta ── */
    setMeta("description", desc);
    setMeta("keywords",    BRAND.keywords + (cfg.kw ? ", " + cfg.kw : ""));
    setMeta("robots", NOINDEX_PAGES.has(key)
      ? "noindex, nofollow"
      : "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1");
    setMeta("author",      BRAND.legalName);
    setMeta("theme-color", "#71ff00");
    setMeta("geo.region",       "KE-110");
    setMeta("geo.placename",    "Nairobi, Kenya");
    setMeta("geo.position",     "-1.286389;36.817223");
    setMeta("ICBM",             "-1.286389, 36.817223");

    /* ── Open Graph ── */
    setMeta("og:type",        "website",  true);
    setMeta("og:site_name",   BRAND.name, true);
    setMeta("og:title",       title,      true);
    setMeta("og:description", desc,       true);
    setMeta("og:url",         url,        true);
    setMeta("og:image",       image,      true);
    setMeta("og:image:width", "1200",     true);
    setMeta("og:image:height","630",      true);
    setMeta("og:locale",      "en_KE",    true);

    /* ── Twitter Card ── */
    setMeta("twitter:card",        "summary_large_image");
    setMeta("twitter:title",       title);
    setMeta("twitter:description", desc);
    setMeta("twitter:image",       image);

    /* ── Canonical ── */
    setLink("canonical", url);

    /* ── Organization + LocalBusiness schema ── */
    injectSchema({
      "@context": "https://schema.org",
      "@type": ["Organization", "LocalBusiness"],
      "name": BRAND.name,
      "brand": "SOKONI",
      "legalName": BRAND.legalName,
      "url": BRAND.url,
      "logo": { "@type": "ImageObject", "url": BRAND.logo, "width": 512, "height": 512 },
      "image": BRAND.logo,
      "description": BRAND.description,
      "telephone": BRAND.phone,
      "email": BRAND.email,
      "currenciesAccepted": "KES",
      "paymentAccepted": "M-Pesa, Visa, Mastercard, PayPal",
      "priceRange": "KSh",
      "areaServed": [
        { "@type": "Country", "name": "Kenya" },
        { "@type": "City", "name": "Nairobi" },
        { "@type": "City", "name": "Mombasa" },
        { "@type": "City", "name": "Kisumu" },
        { "@type": "City", "name": "Nakuru" },
        { "@type": "City", "name": "Eldoret" }
      ],
      "address": {
        "@type": "PostalAddress",
        "streetAddress": BRAND.address.streetAddress,
        "addressLocality": BRAND.address.addressLocality,
        "addressRegion": BRAND.address.addressRegion,
        "postalCode": BRAND.address.postalCode,
        "addressCountry": BRAND.address.addressCountry
      },
      "geo": {
        "@type": "GeoCoordinates",
        "latitude": -1.286389,
        "longitude": 36.817223
      },
      "sameAs": BRAND.sameAs,
      "openingHoursSpecification": {
        "@type": "OpeningHoursSpecification",
        "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],
        "opens": "00:00",
        "closes": "23:59"
      },
      "contactPoint": [
        {
          "@type": "ContactPoint",
          "telephone": BRAND.phone,
          "contactType": "customer support",
          "areaServed": "KE",
          "availableLanguage": ["en", "sw"],
          "contactOption": "TollFree"
        },
        {
          "@type": "ContactPoint",
          "contactType": "sales",
          "email": BRAND.email,
          "areaServed": "KE",
          "availableLanguage": ["en", "sw"]
        }
      ]
    });

    /* ── WebSite schema with Sitelinks SearchBox ── */
    injectSchema({
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": BRAND.name,
      "url": BRAND.url,
      "description": BRAND.description,
      "potentialAction": {
        "@type": "SearchAction",
        "target": {
          "@type": "EntryPoint",
          "urlTemplate": BRAND.url + "/category.html?q={search_term_string}"
        },
        "query-input": "required name=search_term_string"
      }
    });

    /* ── Page-type specific schema ── */
    _injectPageSchema(key, cfg, url, desc);
  }

  function _injectPageSchema(key, cfg, url, desc){
    const type = cfg.type || "WebPage";

    if(type === "Service" && key === "services.html"){
      injectSchema({
        "@context": "https://schema.org",
        "@type": "Service",
        "name": "SOKONI Services — Book Local Professionals in Kenya",
        "description": desc,
        "url": url,
        "provider": { "@type": "Organization", "name": BRAND.legalName },
        "areaServed": { "@type": "Country", "name": "Kenya" },
        "serviceType": [
          "Plumbing", "Electrical", "Cleaning", "Photography", "Graphic Design",
          "Tutoring", "Catering", "Event Planning", "Hair & Beauty", "IT Repair",
          "Fitness Training", "Accounting", "Laundry", "Legal Services", "Healthcare"
        ]
      });
    }

    if(key === "healthcare.html"){
      injectSchema({
        "@context": "https://schema.org",
        "@type": "MedicalOrganization",
        "name": "SOKONI Healthcare Hub",
        "description": desc,
        "url": url,
        "medicalSpecialty": ["GeneralPractice", "EmergencyMedicine", "Pharmacy"],
        "availableService": [
          { "@type": "MedicalProcedure", "name": "Book Doctor Appointment" },
          { "@type": "MedicalProcedure", "name": "Order Medicine Delivery" },
          { "@type": "MedicalProcedure", "name": "Home Lab Tests" }
        ]
      });
    }

    if(key === "property.html"){
      injectSchema({
        "@context": "https://schema.org",
        "@type": "RealEstateAgent",
        "name": "SOKONI Property — Houses & Apartments for Rent",
        "description": desc,
        "url": url,
        "areaServed": { "@type": "Country", "name": "Kenya" }
      });
    }

    if(key === "bnb.html"){
      injectSchema({
        "@context": "https://schema.org",
        "@type": "LodgingBusiness",
        "name": "SOKONI BnB & Short Stay",
        "description": desc,
        "url": url,
        "currenciesAccepted": "KES",
        "paymentAccepted": "M-Pesa, Visa, Mastercard",
        "areaServed": { "@type": "Country", "name": "Kenya" }
      });
    }

    if(key === "flashsale.html"){
      injectSchema({
        "@context": "https://schema.org",
        "@type": "SaleEvent",
        "name": "SOKONI Flash Sales — Daily Deals Kenya",
        "description": desc,
        "url": url,
        "organizer": { "@type": "Organization", "name": BRAND.legalName },
        "location": { "@type": "Country", "name": "Kenya" }
      });
    }

    if(key === "legal-hub.html"){
      injectSchema({
        "@context": "https://schema.org",
        "@type": "LegalService",
        "name": "SOKONI Legal Hub — Advocates & Legal Documents Kenya",
        "description": desc,
        "url": url,
        "areaServed": { "@type": "Country", "name": "Kenya" }
      });
    }

    /* ── Homepage FAQ schema ── */
    if(key === "index.html" || key === ""){
      injectSchema({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
          { "@type":"Question", "name":"How do I buy on SOKONI?", "acceptedAnswer":{ "@type":"Answer", "text":"Browse products, add to cart, enter delivery details and pay via M-Pesa, Visa, Mastercard or PayPal. Delivery available across Kenya." }},
          { "@type":"Question", "name":"How do I pay on SOKONI?", "acceptedAnswer":{ "@type":"Answer", "text":"SOKONI accepts M-Pesa (STK Push), Visa, Mastercard and PayPal. M-Pesa is the most popular option — you'll get a push notification on your phone." }},
          { "@type":"Question", "name":"How do I book a service on SOKONI?", "acceptedAnswer":{ "@type":"Answer", "text":"Go to Services, search or browse by category, select a provider and click Book. Fill in your details and job description — the provider will contact you." }},
          { "@type":"Question", "name":"Is SOKONI available as an app?", "acceptedAnswer":{ "@type":"Answer", "text":"SOKONI is a Progressive Web App (PWA). You can install it directly from your browser — tap 'Add to Home Screen' on Android or iPhone for a full app experience." }},
          { "@type":"Question", "name":"Does SOKONI deliver to my area?", "acceptedAnswer":{ "@type":"Answer", "text":"SOKONI delivers nationwide across Kenya — Nairobi, Mombasa, Kisumu, Nakuru, Eldoret and more. Same-day delivery is available in Nairobi CBD and select suburbs." }}
        ]
      });
    }
  }

  /* ─── Product schema (call from product pages) ─── */
  function setProduct(p){
    if(!p || !p.name) return;

    const price = Number(p.price || p.wholesalePrice || 0);
    const inStock = !p.outOfStock && (p.stock === undefined || p.stock > 0);

    /* Update page meta */
    const title = `${p.name} — Buy Online Kenya | SOKONI`;
    const desc  = (p.description || p.desc || `Buy ${p.name} online in Kenya. Fast delivery. Pay via M-Pesa.`).substring(0, 160);
    document.title = title;
    setMeta("description", desc);
    setMeta("og:title",       title,    true);
    setMeta("og:description", desc,     true);
    setMeta("og:image",       p.image || BRAND.logo, true);
    setMeta("og:type",        "product", true);

    /* Product schema */
    injectSchema({
      "@context": "https://schema.org",
      "@type": "Product",
      "name": p.name,
      "description": desc,
      "image": p.image || BRAND.logo,
      "brand": { "@type": "Brand", "name": p.sellerName || BRAND.name },
      "offers": {
        "@type": "Offer",
        "url": BRAND.url + "/product.html",
        "priceCurrency": "KES",
        "price": price,
        "priceValidUntil": new Date(Date.now() + 30*86400000).toISOString().split("T")[0],
        "itemCondition": "https://schema.org/NewCondition",
        "availability": inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        "seller": { "@type": "Organization", "name": p.sellerName || BRAND.name }
      },
      "aggregateRating": p.rating ? {
        "@type": "AggregateRating",
        "ratingValue": p.rating,
        "reviewCount": p.reviews || p.sold || 1
      } : undefined
    });

    /* BreadcrumbList */
    injectSchema({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type":"ListItem", "position":1, "name":"Home",    "item": BRAND.url },
        { "@type":"ListItem", "position":2, "name":"Shop",    "item": BRAND.url + "/category.html" },
        { "@type":"ListItem", "position":3, "name": p.name }
      ]
    });
  }

  /* ─── Service provider schema ─── */
  function setService(provider){
    if(!provider || !provider.name) return;
    const title = `${provider.name} — ${provider.category || "Service"} in ${provider.location || "Kenya"} | SOKONI`;
    const desc  = (provider.bio || `Book ${provider.name} on SOKONI. ${provider.category} services in ${provider.location||"Kenya"}.`).substring(0, 160);
    document.title = title;
    setMeta("description", desc);
    setMeta("og:title",       title, true);
    setMeta("og:description", desc,  true);

    injectSchema({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      "name": provider.name,
      "description": desc,
      "telephone": provider.phone || "",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": provider.location || "Nairobi",
        "addressCountry": "KE"
      },
      "priceRange": provider.rate ? `KES ${Number(provider.rate).toLocaleString()}` : "Negotiable",
      "aggregateRating": provider.rating ? {
        "@type": "AggregateRating",
        "ratingValue": provider.rating,
        "reviewCount": provider.jobsCompleted || 1
      } : undefined
    });
  }

  /* ─── Property / BnB listing schema ─── */
  function setListing(listing, listingType){
    if(!listing) return;
    const isRental = listingType === "rental";
    const title = isRental
      ? `${listing.title || listing.name} for Rent in ${listing.location} | SOKONI`
      : `${listing.name} BnB — ${listing.location} | SOKONI`;
    const price = isRental ? listing.rent : listing.pricePerNight;
    const desc  = (listing.description || listing.desc || `${title}. Pay with M-Pesa.`).substring(0, 160);
    document.title = title;
    setMeta("description", desc);
    setMeta("og:title",       title,              true);
    setMeta("og:description", desc,               true);
    setMeta("og:image",       listing.image || BRAND.logo, true);

    injectSchema({
      "@context": "https://schema.org",
      "@type": isRental ? "Accommodation" : "LodgingBusiness",
      "name": listing.title || listing.name,
      "description": desc,
      "address": {
        "@type": "PostalAddress",
        "addressLocality": listing.location || "Nairobi",
        "addressCountry": "KE"
      },
      "offers": price ? {
        "@type": "Offer",
        "priceCurrency": "KES",
        "price": price,
        "unitCode": isRental ? "MON" : "DAY"
      } : undefined,
      "image": listing.image || BRAND.logo
    });
  }

  /* ─── Dynamic meta updater for SPA navigation ─── */
  function updatePageMeta(title, description, imageUrl){
    if(title)       { document.title = title + " | SOKONI"; setMeta("og:title", document.title, true); }
    if(description) { setMeta("description", description); setMeta("og:description", description, true); }
    if(imageUrl)    { setMeta("og:image", imageUrl, true); }
  }

  /* ─── Google Analytics 4 purchase event helper ─── */
  function trackPurchase(order){
    if(typeof gtag === "undefined") return;
    gtag("event", "purchase", {
      transaction_id: order.id,
      value:          order.total || 0,
      currency:       "KES",
      items: (order.items || []).map(item => ({
        item_id:   item.id,
        item_name: item.name,
        price:     item.price || 0,
        quantity:  item.qty || 1
      }))
    });
  }

  /* ─── Google Analytics 4 view_item event ─── */
  function trackProductView(product){
    if(typeof gtag === "undefined") return;
    gtag("event", "view_item", {
      currency: "KES",
      value: product.price || 0,
      items: [{ item_id: product.id, item_name: product.name, price: product.price || 0 }]
    });
  }

  /* ─── Auto-run on load ─── */
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { init, setProduct, setService, setListing, updatePageMeta, trackPurchase, trackProductView };

})();

window.SokoniSEO = SokoniSEO;
