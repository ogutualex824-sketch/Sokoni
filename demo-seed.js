/* ================================================================
   SOKONI — Demo Data Seeder  v7.0
   Runs ONCE on first visit (flag: sokoniDemoSeeded)
   Seeds all localStorage keys so every section looks alive.
   Works on ALL domains (localhost + live site) for client testing.
   Include on index.html BEFORE script.js:
     <script src="demo-seed.js"></script>
================================================================ */

(function seedSokoniDemoData() {
  /* Production guard — NEVER seed demo data on the live site.
     Only runs on localhost, 127.0.0.1, or when ?demo=1 query param is explicitly set. */
  const _host  = location.hostname;
  const _isDev = _host === "localhost" || _host === "127.0.0.1" || _host.endsWith(".local");
  const _forceDemo = new URLSearchParams(location.search).get("demo") === "1";
  if (!_isDev && !_forceDemo) return;

  const _sv = localStorage.getItem("sokoniDemoSeeded");
  if (_sv === "7") return;
  /* clear old seed data so everything loads fresh */
  localStorage.removeItem("sokoniDemoSeeded");
  localStorage.removeItem("sellerProducts");
  localStorage.removeItem("sokoniServiceProviders");
  localStorage.removeItem("sokoniFixtures");

  const NOW = Date.now();
  const DAY = 86400000;
  const HR  = 3600000;

  function daysAgo(n){ return NOW - n * DAY; }
  function daysAhead(n){ return NOW + n * DAY; }
  let _uid = 0;
  function uid(base){ return base + (++_uid); }

  /* ═══════════════════════════════════════════════════════════
     1. PRODUCTS  — 5+ items per major category
  ═══════════════════════════════════════════════════════════ */
  const PRODUCTS = [

    /* ── ELECTRONICS ── */
    {
      id: uid("E"), name: "Samsung Galaxy A55 5G",
      price: 52000, costPrice: 44000, deliveryCost: 200, stock: 8, sold: 12,
      category: "electronics", location: "nairobi",
      description: "128GB, 8GB RAM, 5G ready. Sealed in box with 1 year warranty.",
      image: "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400&q=75",
      sellerName: "Sokoni Electronics", sellerEmail: "electronics@sokoni.ke",
      uploadedAt: daysAgo(5), views: 143, outOfStock: false,
      priceHistory: [{ price: 55000, date: "May 2026", timestamp: daysAgo(20) }],
      wishlistCount: 9, kebsCert: ""
    },
    {
      id: uid("E"), name: "Sony WH-1000XM5 Headphones",
      price: 38000, costPrice: 31000, deliveryCost: 200, stock: 3, sold: 5,
      category: "electronics", location: "nairobi",
      description: "Industry-leading noise cancellation. 30hr battery. Genuine Sony.",
      image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400&q=75",
      sellerName: "Sokoni Electronics", sellerEmail: "electronics@sokoni.ke",
      uploadedAt: daysAgo(2), views: 204, outOfStock: false, wishlistCount: 31, kebsCert: "",
      priceHistory: [{ price: 42000, date: "April 2026", timestamp: daysAgo(35) }]
    },
    {
      id: uid("E"), name: "Tecno Camon 20 Pro",
      price: 28500, costPrice: 22000, deliveryCost: 200, stock: 15, sold: 29,
      category: "electronics", location: "nairobi",
      description: "256GB, 8GB RAM, 64MP triple camera. Night shot king. 1yr warranty.",
      image: "https://images.unsplash.com/photo-1592750475338-74b7b21085ab?w=400&q=75",
      sellerName: "Sokoni Electronics", sellerEmail: "electronics@sokoni.ke",
      uploadedAt: daysAgo(4), views: 189, outOfStock: false, wishlistCount: 18, kebsCert: ""
    },
    {
      id: uid("E"), name: "JBL Charge 5 Bluetooth Speaker",
      price: 14500, costPrice: 10500, deliveryCost: 150, stock: 10, sold: 17,
      category: "electronics", location: "nairobi",
      description: "Waterproof, 20hr playtime, power bank function. Original JBL.",
      image: "https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=400&q=75",
      sellerName: "TechMart Nairobi", sellerEmail: "techmart@sokoni.ke",
      uploadedAt: daysAgo(3), views: 77, outOfStock: false, wishlistCount: 12, kebsCert: ""
    },
    {
      id: uid("E"), name: "Samsung 43\" Smart TV",
      price: 42000, costPrice: 33000, deliveryCost: 500, stock: 5, sold: 8,
      category: "electronics", location: "nairobi",
      description: "4K UHD, Netflix/YouTube built-in, 2 HDMI, WiFi. Free wall bracket.",
      image: "https://images.unsplash.com/photo-1593359677879-a4bb92f4834f?w=400&q=75",
      sellerName: "Sokoni Electronics", sellerEmail: "electronics@sokoni.ke",
      uploadedAt: daysAgo(1), views: 98, outOfStock: false, wishlistCount: 22, kebsCert: ""
    },
    {
      id: uid("E"), name: "Xiaomi Redmi Buds 4 Pro",
      price: 4800, costPrice: 3200, deliveryCost: 100, stock: 30, sold: 53,
      category: "electronics", location: "nairobi",
      description: "Active noise cancellation, 36hr total battery, Hi-Res Audio.",
      image: "https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=400&q=75",
      sellerName: "TechMart Nairobi", sellerEmail: "techmart@sokoni.ke",
      uploadedAt: daysAgo(0), views: 65, outOfStock: false, wishlistCount: 8, kebsCert: ""
    },
    {
      id: uid("E"), name: "Anker 20000mAh Power Bank",
      price: 3200, costPrice: 2100, deliveryCost: 100, stock: 40, sold: 74,
      category: "electronics", location: "nairobi",
      description: "65W fast charge, 3 ports (USB-C + 2 USB-A), LED display. Slim.",
      image: "https://images.unsplash.com/photo-1609091839311-d5365f9ff1c5?w=400&q=75",
      sellerName: "TechMart Nairobi", sellerEmail: "techmart@sokoni.ke",
      uploadedAt: daysAgo(0), views: 120, outOfStock: false, wishlistCount: 27, kebsCert: ""
    },

    /* ── FASHION ── */
    {
      id: uid("F"), name: "Ladies Floral Maxi Dress",
      price: 1850, costPrice: 900, deliveryCost: 150, stock: 18, sold: 42,
      category: "fashion", location: "mombasa",
      description: "100% cotton. Sizes S–XL. Available in 3 patterns.",
      image: "https://images.unsplash.com/photo-1495385794356-15371f348c31?w=400&q=75",
      sellerName: "Style Point", sellerEmail: "stylepoint@sokoni.ke",
      uploadedAt: daysAgo(1), views: 73, outOfStock: false, wishlistCount: 7, kebsCert: ""
    },
    {
      id: uid("F"), name: "Men's Classic Slim Fit Suit",
      price: 8500, costPrice: 5200, deliveryCost: 200, stock: 12, sold: 19,
      category: "fashion", location: "nairobi",
      description: "2-piece, poly-wool blend. Navy & Black. Sizes 36–46. Dry-clean included.",
      image: "https://images.unsplash.com/photo-1594938298603-c8148c4b7c0e?w=400&q=75",
      sellerName: "Style Point", sellerEmail: "stylepoint@sokoni.ke",
      uploadedAt: daysAgo(2), views: 55, outOfStock: false, wishlistCount: 11, kebsCert: ""
    },
    {
      id: uid("F"), name: "African Print Ankara Dress",
      price: 2200, costPrice: 1000, deliveryCost: 150, stock: 22, sold: 68,
      category: "fashion", location: "nairobi",
      description: "Bold Ankara fabric, custom tailored to your measurements. 5-day turnaround.",
      image: "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=400&q=75",
      sellerName: "Nairobi Fashion House", sellerEmail: "nfh@sokoni.ke",
      uploadedAt: daysAgo(3), views: 134, outOfStock: false, wishlistCount: 34, kebsCert: ""
    },
    {
      id: uid("F"), name: "Denim Jacket — Unisex",
      price: 2800, costPrice: 1600, deliveryCost: 150, stock: 30, sold: 46,
      category: "fashion", location: "nairobi",
      description: "Heavy-wash denim, button-front. Available in light & dark blue. Sizes XS–XXL.",
      image: "https://images.unsplash.com/photo-1544022613-e87ca75a784a?w=400&q=75",
      sellerName: "Style Point", sellerEmail: "stylepoint@sokoni.ke",
      uploadedAt: daysAgo(1), views: 92, outOfStock: false, wishlistCount: 14, kebsCert: ""
    },
    {
      id: uid("F"), name: "Kids School Uniform Set",
      price: 1200, costPrice: 650, deliveryCost: 100, stock: 60, sold: 112,
      category: "fashion", location: "nairobi",
      description: "Shirt + short/skirt + sweater. Specify school & size at order. All ages.",
      image: "https://images.unsplash.com/photo-1580582932707-520aed937b7b?w=400&q=75",
      sellerName: "KenShop", sellerEmail: "kenshop@sokoni.ke",
      uploadedAt: daysAgo(4), views: 218, outOfStock: false, wishlistCount: 5, kebsCert: ""
    },
    {
      id: uid("F"), name: "Oversized Graphic Hoodie",
      price: 1600, costPrice: 800, deliveryCost: 150, stock: 45, sold: 87,
      category: "fashion", location: "nairobi",
      description: "100% cotton fleece. Nairobi / Africa prints. Unisex, sizes S–3XL.",
      image: "https://images.unsplash.com/photo-1556821840-3a63f15732ce?w=400&q=75",
      sellerName: "Kaspa Prints", sellerEmail: "kaspa@sokoni.ke",
      uploadedAt: daysAgo(0), views: 178, outOfStock: false, wishlistCount: 29, kebsCert: ""
    },

    /* ── BEAUTY & SKINCARE ── */
    {
      id: uid("B"), name: "Organic Skincare Set",
      price: 2200, costPrice: 1100, deliveryCost: 150, stock: 30, sold: 53,
      category: "beauty", location: "nairobi",
      description: "6-piece set: cleanser, toner, serum, moisturiser, eye cream, SPF. Halal certified.",
      image: "https://images.unsplash.com/photo-1571781926291-c477ebfd024b?w=400&q=75",
      sellerName: "Glow Natural KE", sellerEmail: "glownaturalke@sokoni.ke",
      uploadedAt: daysAgo(0), views: 91, outOfStock: false, wishlistCount: 11, kebsCert: ""
    },
    {
      id: uid("B"), name: "Brazilian Hair Extension 22\"",
      price: 5500, costPrice: 3200, deliveryCost: 200, stock: 20, sold: 34,
      category: "beauty", location: "nairobi",
      description: "100% human hair, 220g bundle. Natural black. Sew-in or clip-in available.",
      image: "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=400&q=75",
      sellerName: "Glow Natural KE", sellerEmail: "glownaturalke@sokoni.ke",
      uploadedAt: daysAgo(2), views: 76, outOfStock: false, wishlistCount: 18, kebsCert: ""
    },
    {
      id: uid("B"), name: "MAC Makeup Bundle (12pcs)",
      price: 4800, costPrice: 2900, deliveryCost: 150, stock: 15, sold: 28,
      category: "beauty", location: "nairobi",
      description: "Foundation, concealer, blush, highlighter, eyeshadow palette, mascara & more.",
      image: "https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=400&q=75",
      sellerName: "Beauty Hub KE", sellerEmail: "beautyhub@sokoni.ke",
      uploadedAt: daysAgo(3), views: 109, outOfStock: false, wishlistCount: 22, kebsCert: ""
    },
    {
      id: uid("B"), name: "Chanel Bleu de Chanel (100ml)",
      price: 8800, costPrice: 6200, deliveryCost: 150, stock: 8, sold: 11,
      category: "beauty", location: "nairobi",
      description: "Original 100ml EDP. Long-lasting masculine fragrance. Sealed box.",
      image: "https://images.unsplash.com/photo-1563170351-be82bc888aa4?w=400&q=75",
      sellerName: "Beauty Hub KE", sellerEmail: "beautyhub@sokoni.ke",
      uploadedAt: daysAgo(1), views: 48, outOfStock: false, wishlistCount: 9, kebsCert: ""
    },
    {
      id: uid("B"), name: "Professional Nail Art Kit",
      price: 1800, costPrice: 900, deliveryCost: 100, stock: 25, sold: 41,
      category: "beauty", location: "nairobi",
      description: "40-piece: gel polishes, lamp, nail file, buffer, brushes. Salon quality at home.",
      image: "https://images.unsplash.com/photo-1604654894610-df63bc536371?w=400&q=75",
      sellerName: "Glow Natural KE", sellerEmail: "glownaturalke@sokoni.ke",
      uploadedAt: daysAgo(0), views: 64, outOfStock: false, wishlistCount: 7, kebsCert: ""
    },
    {
      id: uid("B"), name: "Korean Glass Skin Face Mask Set",
      price: 950, costPrice: 450, deliveryCost: 100, stock: 80, sold: 156,
      category: "beauty", location: "nairobi",
      description: "10-pack hydrogel masks: hyaluronic acid, collagen, vitamin C variants. No parabens.",
      image: "https://images.unsplash.com/photo-1570172619644-dfd03ed5d881?w=400&q=75",
      sellerName: "Beauty Hub KE", sellerEmail: "beautyhub@sokoni.ke",
      uploadedAt: daysAgo(0), views: 203, outOfStock: false, wishlistCount: 33, kebsCert: ""
    },

    /* ── FOOD & GROCERIES ── */
    {
      id: uid("G"), name: "Avocado 1kg (Fresh Hass)",
      price: 120, costPrice: 60, deliveryCost: 0, stock: 50, sold: 89,
      category: "food", location: "nairobi",
      description: "Farm-fresh from Muranga. Same day delivery in Nairobi.",
      image: "https://images.unsplash.com/photo-1523049673857-eb18f1d7b578?w=400&q=75",
      sellerName: "Green Farm Kenya", sellerEmail: "greenfarm@sokoni.ke",
      uploadedAt: daysAgo(2), views: 56, outOfStock: false, wishlistCount: 3, kebsCert: ""
    },
    {
      id: uid("G"), name: "Basmati Rice 5kg",
      price: 850, costPrice: 650, deliveryCost: 0, stock: 200, sold: 312,
      category: "food", location: "nairobi",
      description: "Premium long-grain basmati. Fragrant & fluffy. Packed fresh.",
      image: "https://images.unsplash.com/photo-1586201375761-83865001e31c?w=400&q=75",
      sellerName: "Green Farm Kenya", sellerEmail: "greenfarm@sokoni.ke",
      uploadedAt: daysAgo(1), views: 134, outOfStock: false, wishlistCount: 6, kebsCert: ""
    },
    {
      id: uid("G"), name: "Fresh Eggs (Tray of 30)",
      price: 480, costPrice: 350, deliveryCost: 0, stock: 100, sold: 248,
      category: "food", location: "nairobi",
      description: "Free-range, jumbo eggs. Collected same day. Nairobi delivery.",
      image: "https://images.unsplash.com/photo-1518569656558-1f25e69d2d2d?w=400&q=75",
      sellerName: "Green Farm Kenya", sellerEmail: "greenfarm@sokoni.ke",
      uploadedAt: daysAgo(0), views: 88, outOfStock: false, wishlistCount: 4, kebsCert: ""
    },
    {
      id: uid("G"), name: "Fresh Whole Milk 1L × 6",
      price: 540, costPrice: 400, deliveryCost: 50, stock: 60, sold: 178,
      category: "food", location: "nairobi",
      description: "Pasteurised, full cream. Packed daily from Limuru farm. Coldchain delivery.",
      image: "https://images.unsplash.com/photo-1550583724-b2692b85b150?w=400&q=75",
      sellerName: "Green Farm Kenya", sellerEmail: "greenfarm@sokoni.ke",
      uploadedAt: daysAgo(0), views: 72, outOfStock: false, wishlistCount: 2, kebsCert: ""
    },
    {
      id: uid("G"), name: "Unga wa Ugali (Maize Meal) 5kg",
      price: 380, costPrice: 280, deliveryCost: 0, stock: 500, sold: 892,
      category: "food", location: "nairobi",
      description: "Fine-ground white maize. No preservatives. Nairobi same-day delivery.",
      image: "https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=400&q=75",
      sellerName: "Green Farm Kenya", sellerEmail: "greenfarm@sokoni.ke",
      uploadedAt: daysAgo(1), views: 45, outOfStock: false, wishlistCount: 1, kebsCert: ""
    },
    {
      id: uid("G"), name: "Vegetable Hamper — Family Pack",
      price: 650, costPrice: 420, deliveryCost: 0, stock: 30, sold: 64,
      category: "food", location: "nairobi",
      description: "Tomatoes, onions, spinach, carrots, capsicum, garlic. Fresh farm delivery.",
      image: "https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=75",
      sellerName: "Green Farm Kenya", sellerEmail: "greenfarm@sokoni.ke",
      uploadedAt: daysAgo(0), views: 91, outOfStock: false, wishlistCount: 5, kebsCert: ""
    },

    /* ── FURNITURE & HOME ── */
    {
      id: uid("H"), name: "Sofa Set 7-Seater L-Shape",
      price: 48500, costPrice: 35000, deliveryCost: 800, stock: 2, sold: 1,
      category: "furniture", location: "nairobi",
      description: "High density foam. Delivery & assembly included Nairobi CBD.",
      image: "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&q=75",
      sellerName: "HomePlus Kenya", sellerEmail: "homeplus@sokoni.ke",
      uploadedAt: daysAgo(1), views: 38, outOfStock: false, wishlistCount: 5, kebsCert: ""
    },
    {
      id: uid("H"), name: "King Size Bed Frame (Wooden)",
      price: 32000, costPrice: 22000, deliveryCost: 600, stock: 4, sold: 6,
      category: "furniture", location: "nairobi",
      description: "Solid mahogany. 6×6 ft. With or without headboard. Assembly included.",
      image: "https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?w=400&q=75",
      sellerName: "HomePlus Kenya", sellerEmail: "homeplus@sokoni.ke",
      uploadedAt: daysAgo(3), views: 62, outOfStock: false, wishlistCount: 8, kebsCert: ""
    },
    {
      id: uid("H"), name: "Executive Office Chair",
      price: 12500, costPrice: 8000, deliveryCost: 400, stock: 10, sold: 14,
      category: "furniture", location: "nairobi",
      description: "Ergonomic mesh back, adjustable height & tilt, lumbar support. 150kg rated.",
      image: "https://images.unsplash.com/photo-1580480055273-228ff5388ef8?w=400&q=75",
      sellerName: "HomePlus Kenya", sellerEmail: "homeplus@sokoni.ke",
      uploadedAt: daysAgo(2), views: 49, outOfStock: false, wishlistCount: 11, kebsCert: ""
    },
    {
      id: uid("H"), name: "6-Seater Dining Table Set",
      price: 28000, costPrice: 19000, deliveryCost: 700, stock: 3, sold: 4,
      category: "furniture", location: "nairobi",
      description: "Glass top, metal legs. Includes 6 padded chairs. Modern design.",
      image: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400&q=75",
      sellerName: "HomePlus Kenya", sellerEmail: "homeplus@sokoni.ke",
      uploadedAt: daysAgo(4), views: 33, outOfStock: false, wishlistCount: 6, kebsCert: ""
    },
    {
      id: uid("H"), name: "4-Door Wardrobe (Mirror Front)",
      price: 22000, costPrice: 15000, deliveryCost: 600, stock: 5, sold: 7,
      category: "furniture", location: "nairobi",
      description: "180cm wide, full mirror doors, hanging rail + shelves. Assembly included.",
      image: "https://images.unsplash.com/photo-1558997519-83ea9252edf8?w=400&q=75",
      sellerName: "HomePlus Kenya", sellerEmail: "homeplus@sokoni.ke",
      uploadedAt: daysAgo(0), views: 57, outOfStock: false, wishlistCount: 9, kebsCert: ""
    },
    {
      id: uid("H"), name: "LED TV Stand — Floating Mount",
      price: 8500, costPrice: 5500, deliveryCost: 400, stock: 8, sold: 12,
      category: "furniture", location: "nairobi",
      description: "Wall-mounted, fits 40–65\" TVs. 2 cable shelves. Matte black finish.",
      image: "https://images.unsplash.com/photo-1593359677879-a4bb92f4834f?w=400&q=75",
      sellerName: "HomePlus Kenya", sellerEmail: "homeplus@sokoni.ke",
      uploadedAt: daysAgo(1), views: 41, outOfStock: false, wishlistCount: 4, kebsCert: ""
    },

    /* ── SHOES & FOOTWEAR ── */
    {
      id: uid("S"), name: "Men's Genuine Leather Sneakers",
      price: 3800, costPrice: 2200, deliveryCost: 150, stock: 25, sold: 34,
      category: "shoes", location: "nairobi",
      description: "Genuine leather upper, rubber sole. Sizes 39–45. Black & white.",
      image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400&q=75",
      sellerName: "KenShop", sellerEmail: "kenshop@sokoni.ke",
      uploadedAt: daysAgo(4), views: 87, outOfStock: false, wishlistCount: 14, kebsCert: ""
    },
    {
      id: uid("S"), name: "Ladies Block Heel Pumps",
      price: 2200, costPrice: 1200, deliveryCost: 150, stock: 20, sold: 41,
      category: "shoes", location: "nairobi",
      description: "Faux leather, 8cm block heel. Black & nude. Sizes 36–41. Office-ready.",
      image: "https://images.unsplash.com/photo-1543163521-1bf539c55dd2?w=400&q=75",
      sellerName: "KenShop", sellerEmail: "kenshop@sokoni.ke",
      uploadedAt: daysAgo(2), views: 104, outOfStock: false, wishlistCount: 19, kebsCert: ""
    },
    {
      id: uid("S"), name: "Nike Air Max 270 (Original)",
      price: 12000, costPrice: 9000, deliveryCost: 200, stock: 6, sold: 8,
      category: "shoes", location: "nairobi",
      description: "Original Nike. 270 Air cushion. Sizes 40–46. White/black available.",
      image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400&q=75",
      sellerName: "Sokoni Electronics", sellerEmail: "electronics@sokoni.ke",
      uploadedAt: daysAgo(1), views: 77, outOfStock: false, wishlistCount: 21, kebsCert: ""
    },
    {
      id: uid("S"), name: "Kids School Bata Shoes",
      price: 1100, costPrice: 700, deliveryCost: 100, stock: 80, sold: 203,
      category: "shoes", location: "nairobi",
      description: "Original Bata. Black leather. Sizes 28–38. Extra durable sole.",
      image: "https://images.unsplash.com/photo-1560769629-975ec94e6a86?w=400&q=75",
      sellerName: "KenShop", sellerEmail: "kenshop@sokoni.ke",
      uploadedAt: daysAgo(3), views: 145, outOfStock: false, wishlistCount: 6, kebsCert: ""
    },
    {
      id: uid("S"), name: "Men's Formal Leather Oxford",
      price: 4500, costPrice: 2800, deliveryCost: 150, stock: 18, sold: 27,
      category: "shoes", location: "nairobi",
      description: "Full-grain leather, rubber sole. Brown & Black. Sizes 40–46. Italian style.",
      image: "https://images.unsplash.com/photo-1533867617858-e7b97e060509?w=400&q=75",
      sellerName: "Style Point", sellerEmail: "stylepoint@sokoni.ke",
      uploadedAt: daysAgo(0), views: 62, outOfStock: false, wishlistCount: 10, kebsCert: ""
    },
    {
      id: uid("S"), name: "Rubber Sandals (Unisex)",
      price: 650, costPrice: 300, deliveryCost: 100, stock: 100, sold: 289,
      category: "shoes", location: "nairobi",
      description: "Anti-slip EVA sole. Waterproof. Sizes 36–45. Red, blue, black, green.",
      image: "https://images.unsplash.com/photo-1603487742131-4160ec999306?w=400&q=75",
      sellerName: "KenShop", sellerEmail: "kenshop@sokoni.ke",
      uploadedAt: daysAgo(0), views: 38, outOfStock: false, wishlistCount: 2, kebsCert: ""
    },

    /* ── COMPUTERS & LAPTOPS ── */
    {
      id: uid("C"), name: "HP EliteBook 840 G6 Laptop",
      price: 62000, costPrice: 52000, deliveryCost: 200, stock: 4, sold: 7,
      category: "computers", location: "nairobi",
      description: "Core i7, 16GB RAM, 512GB SSD, 14\" FHD. Tested & working.",
      image: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?w=400&q=75",
      sellerName: "TechMart Nairobi", sellerEmail: "techmart@sokoni.ke",
      uploadedAt: daysAgo(0), views: 128, outOfStock: false, wishlistCount: 24, kebsCert: ""
    },
    {
      id: uid("C"), name: "MacBook Air M2 (2023)",
      price: 145000, costPrice: 125000, deliveryCost: 200, stock: 2, sold: 3,
      category: "computers", location: "nairobi",
      description: "8GB RAM, 256GB SSD, 13.6\" Liquid Retina. Starlight. Original receipt.",
      image: "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=400&q=75",
      sellerName: "TechMart Nairobi", sellerEmail: "techmart@sokoni.ke",
      uploadedAt: daysAgo(1), views: 312, outOfStock: false, wishlistCount: 67, kebsCert: ""
    },
    {
      id: uid("C"), name: "Dell Inspiron 15 (i5, 2024)",
      price: 58000, costPrice: 48000, deliveryCost: 200, stock: 6, sold: 9,
      category: "computers", location: "nairobi",
      description: "Intel i5-1235U, 8GB RAM, 512GB SSD, 15.6\" FHD. Sealed box.",
      image: "https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=400&q=75",
      sellerName: "TechMart Nairobi", sellerEmail: "techmart@sokoni.ke",
      uploadedAt: daysAgo(2), views: 97, outOfStock: false, wishlistCount: 18, kebsCert: ""
    },
    {
      id: uid("C"), name: "Logitech MX Master 3 Mouse",
      price: 8200, costPrice: 6000, deliveryCost: 100, stock: 12, sold: 19,
      category: "computers", location: "nairobi",
      description: "Wireless, 8K DPI, USB-C charge, 70-day battery, multi-device. Original.",
      image: "https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?w=400&q=75",
      sellerName: "TechMart Nairobi", sellerEmail: "techmart@sokoni.ke",
      uploadedAt: daysAgo(3), views: 54, outOfStock: false, wishlistCount: 12, kebsCert: ""
    },
    {
      id: uid("C"), name: "Mechanical Gaming Keyboard",
      price: 6500, costPrice: 4200, deliveryCost: 150, stock: 9, sold: 13,
      category: "computers", location: "nairobi",
      description: "Red switches, RGB per-key, full 104-key US layout. USB-A. Clicky & fast.",
      image: "https://images.unsplash.com/photo-1541140532154-b024d705b90a?w=400&q=75",
      sellerName: "TechMart Nairobi", sellerEmail: "techmart@sokoni.ke",
      uploadedAt: daysAgo(0), views: 71, outOfStock: false, wishlistCount: 15, kebsCert: ""
    },
    {
      id: uid("C"), name: "24\" FHD Monitor (IPS)",
      price: 18500, costPrice: 13500, deliveryCost: 300, stock: 7, sold: 10,
      category: "computers", location: "nairobi",
      description: "1080p IPS, 75Hz, 5ms, HDMI + VGA. Frameless. VESA mount compatible.",
      image: "https://images.unsplash.com/photo-1527443224154-c4a573d5f5e9?w=400&q=75",
      sellerName: "TechMart Nairobi", sellerEmail: "techmart@sokoni.ke",
      uploadedAt: daysAgo(1), views: 44, outOfStock: false, wishlistCount: 9, kebsCert: ""
    },

    /* ── PRINTING ── */
    {
      id: uid("P"), name: "Custom T-Shirt Printing",
      price: 650, costPrice: 280, deliveryCost: 100, stock: 9999, sold: 215,
      category: "printing", location: "nairobi",
      description: "Full colour digital print. Own design or we design for you. Min 1 piece.",
      image: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&q=75",
      sellerName: "Kaspa Prints", sellerEmail: "kaspa@sokoni.ke",
      uploadedAt: daysAgo(3), views: 312, outOfStock: false, wishlistCount: 22, kebsCert: ""
    },
    {
      id: uid("P"), name: "Business Cards (500 pcs)",
      price: 800, costPrice: 350, deliveryCost: 100, stock: 9999, sold: 441,
      category: "printing", location: "nairobi",
      description: "Matt laminate / gloss. Full colour both sides. 350gsm. 24hr printing.",
      image: "https://images.unsplash.com/photo-1606857521015-7f9fcf423740?w=400&q=75",
      sellerName: "Kaspa Prints", sellerEmail: "kaspa@sokoni.ke",
      uploadedAt: daysAgo(1), views: 188, outOfStock: false, wishlistCount: 14, kebsCert: ""
    },
    {
      id: uid("P"), name: "Branded Flex Banner (3×6 ft)",
      price: 1800, costPrice: 900, deliveryCost: 300, stock: 9999, sold: 128,
      category: "printing", location: "nairobi",
      description: "UV-resistant vinyl, 440gsm. Eyelets included. Full colour print. 24hr.",
      image: "https://images.unsplash.com/photo-1598520106830-8c45c2035460?w=400&q=75",
      sellerName: "Kaspa Prints", sellerEmail: "kaspa@sokoni.ke",
      uploadedAt: daysAgo(2), views: 67, outOfStock: false, wishlistCount: 5, kebsCert: ""
    },
    {
      id: uid("P"), name: "Branded Polo Shirts (Min 10)",
      price: 900, costPrice: 500, deliveryCost: 200, stock: 9999, sold: 87,
      category: "printing", location: "nairobi",
      description: "Embroidery or print. Corporate logos. Colour & size mix allowed.",
      image: "https://images.unsplash.com/photo-1598032895397-b9472444bf93?w=400&q=75",
      sellerName: "Kaspa Prints", sellerEmail: "kaspa@sokoni.ke",
      uploadedAt: daysAgo(0), views: 54, outOfStock: false, wishlistCount: 7, kebsCert: ""
    },
    {
      id: uid("P"), name: "A4 Flyer Printing (1000 pcs)",
      price: 2200, costPrice: 1200, deliveryCost: 200, stock: 9999, sold: 312,
      category: "printing", location: "nairobi",
      description: "Full colour, gloss/matt. Same-day printing available. Design help free.",
      image: "https://images.unsplash.com/photo-1586717791821-3f44a563fa4c?w=400&q=75",
      sellerName: "Kaspa Prints", sellerEmail: "kaspa@sokoni.ke",
      uploadedAt: daysAgo(1), views: 99, outOfStock: false, wishlistCount: 11, kebsCert: ""
    },

    /* ── GRAPHIC DESIGN (DIGITAL SERVICES) ── */
    {
      id: uid("D"), name: "Professional Logo Design Package",
      price: 2500, costPrice: 0, deliveryCost: 0, stock: 9999, sold: 78,
      category: "graphic-design", location: "remote",
      description: "3 concepts, unlimited revisions, PNG/SVG/PDF. 48hr delivery.",
      image: "https://images.unsplash.com/photo-1561070791-2526d30994b5?w=400&q=75",
      sellerName: "Creative Hub KE", sellerEmail: "creative@sokoni.ke",
      uploadedAt: daysAgo(0), views: 195, outOfStock: false, wishlistCount: 19, isService: true, kebsCert: ""
    },
    {
      id: uid("D"), name: "Website Design (5 Pages)",
      price: 18000, costPrice: 0, deliveryCost: 0, stock: 9999, sold: 24,
      category: "graphic-design", location: "remote",
      description: "Mobile-first HTML/CSS/JS or WordPress. SEO ready. 7-day delivery. Free hosting guidance.",
      image: "https://images.unsplash.com/photo-1467232004584-a241de8bcf5d?w=400&q=75",
      sellerName: "Creative Hub KE", sellerEmail: "creative@sokoni.ke",
      uploadedAt: daysAgo(2), views: 132, outOfStock: false, wishlistCount: 15, isService: true, kebsCert: ""
    },
    {
      id: uid("D"), name: "Social Media Graphics Package",
      price: 3500, costPrice: 0, deliveryCost: 0, stock: 9999, sold: 112,
      category: "graphic-design", location: "remote",
      description: "30 branded posts (Instagram, FB, Twitter). Canva template included. 3-day delivery.",
      image: "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=400&q=75",
      sellerName: "Creative Hub KE", sellerEmail: "creative@sokoni.ke",
      uploadedAt: daysAgo(1), views: 88, outOfStock: false, wishlistCount: 13, isService: true, kebsCert: ""
    },
    {
      id: uid("D"), name: "Product Photography (10 shots)",
      price: 4000, costPrice: 0, deliveryCost: 0, stock: 9999, sold: 67,
      category: "graphic-design", location: "nairobi",
      description: "Professional studio shots with white background. Retouched JPEG + PNG. 24hr.",
      image: "https://images.unsplash.com/photo-1542038784456-1ea8e935640e?w=400&q=75",
      sellerName: "Creative Hub KE", sellerEmail: "creative@sokoni.ke",
      uploadedAt: daysAgo(3), views: 74, outOfStock: false, wishlistCount: 8, isService: true, kebsCert: ""
    },
    {
      id: uid("D"), name: "Brand Identity Full Package",
      price: 8500, costPrice: 0, deliveryCost: 0, stock: 9999, sold: 31,
      category: "graphic-design", location: "remote",
      description: "Logo, colours, fonts, business cards, letterhead, brand guide PDF. 5-day delivery.",
      image: "https://images.unsplash.com/photo-1553484771-371a605b060b?w=400&q=75",
      sellerName: "Creative Hub KE", sellerEmail: "creative@sokoni.ke",
      uploadedAt: daysAgo(0), views: 142, outOfStock: false, wishlistCount: 21, isService: true, kebsCert: ""
    },

    /* ── HOME APPLIANCES ── */
    {
      id: uid("A"), name: "Blueflame 3-Burner Gas Cooker",
      price: 16500, costPrice: 12000, deliveryCost: 400, stock: 8, sold: 14,
      category: "appliances", location: "nairobi",
      description: "Auto-ignition, stainless steel top, 2yr warranty. Includes regulator & pipe.",
      image: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400&q=75",
      sellerName: "HomePlus Kenya", sellerEmail: "homeplus@sokoni.ke",
      uploadedAt: daysAgo(2), views: 88, outOfStock: false, wishlistCount: 12, kebsCert: ""
    },
    {
      id: uid("A"), name: "Ramtons 1.8L Rice Cooker",
      price: 2800, costPrice: 1800, deliveryCost: 200, stock: 20, sold: 38,
      category: "appliances", location: "nairobi",
      description: "Non-stick inner pot, auto keep-warm, steam tray included. 1yr warranty.",
      image: "https://images.unsplash.com/photo-1585515320310-259814833e62?w=400&q=75",
      sellerName: "HomePlus Kenya", sellerEmail: "homeplus@sokoni.ke",
      uploadedAt: daysAgo(1), views: 55, outOfStock: false, wishlistCount: 7, kebsCert: ""
    },
    {
      id: uid("A"), name: "Vitron 20L Microwave Oven",
      price: 8500, costPrice: 6000, deliveryCost: 300, stock: 6, sold: 9,
      category: "appliances", location: "nairobi",
      description: "700W, 5 power levels, defrost, timer. Digital panel. 1yr Vitron warranty.",
      image: "https://images.unsplash.com/photo-1574269909862-7e1d70bb8078?w=400&q=75",
      sellerName: "HomePlus Kenya", sellerEmail: "homeplus@sokoni.ke",
      uploadedAt: daysAgo(3), views: 42, outOfStock: false, wishlistCount: 5, kebsCert: ""
    },
    {
      id: uid("A"), name: "Butterfly 2.0L Blender",
      price: 3200, costPrice: 2100, deliveryCost: 200, stock: 15, sold: 27,
      category: "appliances", location: "nairobi",
      description: "800W motor, stainless blades, glass jar, 3 speeds + pulse. 2yr warranty.",
      image: "https://images.unsplash.com/photo-1570197571499-166b36435e9f?w=400&q=75",
      sellerName: "HomePlus Kenya", sellerEmail: "homeplus@sokoni.ke",
      uploadedAt: daysAgo(0), views: 37, outOfStock: false, wishlistCount: 4, kebsCert: ""
    },
    {
      id: uid("A"), name: "Mika Steam Iron (2400W)",
      price: 1800, costPrice: 1100, deliveryCost: 150, stock: 30, sold: 61,
      category: "appliances", location: "nairobi",
      description: "Self-cleaning, anti-drip, spray mist. Ceramic soleplate. Vertical steam.",
      image: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=75",
      sellerName: "HomePlus Kenya", sellerEmail: "homeplus@sokoni.ke",
      uploadedAt: daysAgo(1), views: 29, outOfStock: false, wishlistCount: 3, kebsCert: ""
    },

    /* ── SPORTS & FITNESS ── */
    {
      id: uid("SP"), name: "Adidas Size 5 Football",
      price: 3500, costPrice: 2200, deliveryCost: 150, stock: 25, sold: 41,
      category: "sports", location: "nairobi",
      description: "Official size & weight. Machine-stitched. Works on all surfaces.",
      image: "https://images.unsplash.com/photo-1614632537197-38a17061c2bd?w=400&q=75",
      sellerName: "KenShop", sellerEmail: "kenshop@sokoni.ke",
      uploadedAt: daysAgo(1), views: 78, outOfStock: false, wishlistCount: 9, kebsCert: ""
    },
    {
      id: uid("SP"), name: "Yoga Mat — Non-Slip 6mm",
      price: 1400, costPrice: 800, deliveryCost: 150, stock: 40, sold: 73,
      category: "sports", location: "nairobi",
      description: "TPE eco-friendly, 183×61cm, alignment lines. Carry strap included.",
      image: "https://images.unsplash.com/photo-1601925228459-354b4f88e0f3?w=400&q=75",
      sellerName: "KenShop", sellerEmail: "kenshop@sokoni.ke",
      uploadedAt: daysAgo(0), views: 53, outOfStock: false, wishlistCount: 6, kebsCert: ""
    },
    {
      id: uid("SP"), name: "Adjustable Dumbbell Set (20kg)",
      price: 8500, costPrice: 5500, deliveryCost: 400, stock: 8, sold: 12,
      category: "sports", location: "nairobi",
      description: "Cast iron, rubberized. 4×2.5kg + 4×5kg + handles. Home gym ready.",
      image: "https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=400&q=75",
      sellerName: "KenShop", sellerEmail: "kenshop@sokoni.ke",
      uploadedAt: daysAgo(2), views: 64, outOfStock: false, wishlistCount: 11, kebsCert: ""
    },
    {
      id: uid("SP"), name: "Speed Jump Rope (Ball Bearing)",
      price: 650, costPrice: 300, deliveryCost: 100, stock: 80, sold: 134,
      category: "sports", location: "nairobi",
      description: "Aluminium handles, 3m steel cable, 360° ball bearing. Adjustable length.",
      image: "https://images.unsplash.com/photo-1517438476312-10d79c077509?w=400&q=75",
      sellerName: "KenShop", sellerEmail: "kenshop@sokoni.ke",
      uploadedAt: daysAgo(0), views: 44, outOfStock: false, wishlistCount: 3, kebsCert: ""
    },
    {
      id: uid("SP"), name: "Resistance Bands Set (5 levels)",
      price: 1200, costPrice: 650, deliveryCost: 100, stock: 60, sold: 98,
      category: "sports", location: "nairobi",
      description: "Latex-free TPE. 5 resistance levels (10–50lb). Carry bag + anchor included.",
      image: "https://images.unsplash.com/photo-1598971861713-54ad16a7e72e?w=400&q=75",
      sellerName: "KenShop", sellerEmail: "kenshop@sokoni.ke",
      uploadedAt: daysAgo(1), views: 67, outOfStock: false, wishlistCount: 8, kebsCert: ""
    },

    /* ── BOOKS & STATIONERY ── */
    {
      id: uid("K"), name: "KCSE Past Papers Bundle (2019–2024)",
      price: 850, costPrice: 400, deliveryCost: 100, stock: 9999, sold: 412,
      category: "books", location: "nairobi",
      description: "All 9 subjects. Typed, printed & bound. Marking schemes included.",
      image: "https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=400&q=75",
      sellerName: "EduStore KE", sellerEmail: "edustore@sokoni.ke",
      uploadedAt: daysAgo(1), views: 287, outOfStock: false, wishlistCount: 18, kebsCert: ""
    },
    {
      id: uid("K"), name: "Python for Beginners (Autographed)",
      price: 1800, costPrice: 1200, deliveryCost: 150, stock: 30, sold: 45,
      category: "books", location: "nairobi",
      description: "600 pages, full colour exercises. Perfect for form 4 students & adult learners.",
      image: "https://images.unsplash.com/photo-1515378791036-0648a3ef77b2?w=400&q=75",
      sellerName: "EduStore KE", sellerEmail: "edustore@sokoni.ke",
      uploadedAt: daysAgo(2), views: 88, outOfStock: false, wishlistCount: 11, kebsCert: ""
    },
    {
      id: uid("K"), name: "Executive A5 Leather Notebook",
      price: 650, costPrice: 350, deliveryCost: 100, stock: 100, sold: 213,
      category: "books", location: "nairobi",
      description: "PU leather cover, 200 ruled pages, pen loop, bookmark ribbon. Brown & black.",
      image: "https://images.unsplash.com/photo-1512820790803-83ca734da794?w=400&q=75",
      sellerName: "EduStore KE", sellerEmail: "edustore@sokoni.ke",
      uploadedAt: daysAgo(0), views: 74, outOfStock: false, wishlistCount: 7, kebsCert: ""
    },
    {
      id: uid("K"), name: "Student Geometry Set + Calculator",
      price: 750, costPrice: 400, deliveryCost: 100, stock: 200, sold: 378,
      category: "books", location: "nairobi",
      description: "Casio FX-82MS + geometry set. KCSE approved. Package deal.",
      image: "https://images.unsplash.com/photo-1564325724739-bae0bd08762c?w=400&q=75",
      sellerName: "EduStore KE", sellerEmail: "edustore@sokoni.ke",
      uploadedAt: daysAgo(3), views: 152, outOfStock: false, wishlistCount: 5, kebsCert: ""
    },
    {
      id: uid("K"), name: "Motivational Business Books Set (3)",
      price: 2200, costPrice: 1400, deliveryCost: 150, stock: 40, sold: 61,
      category: "books", location: "nairobi",
      description: "Rich Dad Poor Dad + Think & Grow Rich + Atomic Habits. Brand new copies.",
      image: "https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=400&q=75",
      sellerName: "EduStore KE", sellerEmail: "edustore@sokoni.ke",
      uploadedAt: daysAgo(1), views: 119, outOfStock: false, wishlistCount: 14, kebsCert: ""
    },

    /* ── LAUNDRY (MAMAFUA) ── */
    {
      id: uid("LN"), name: "Wash & Fold — Per Kg",
      price: 80, costPrice: 30, deliveryCost: 0, stock: 9999, sold: 534,
      category: "laundry", location: "nairobi",
      description: "Same-day wash, dry & fold. Min 3 kg. Free pickup & delivery in Nairobi. Sorted & packed per owner.",
      image: "https://images.unsplash.com/photo-1604335399105-a0c585fd81a1?w=400&q=75",
      sellerName: "Mama Clean Laundry", sellerEmail: "mamaclean@sokoni.ke",
      uploadedAt: daysAgo(1), views: 412, outOfStock: false, wishlistCount: 47, isService: true, kebsCert: ""
    },
    {
      id: uid("LN"), name: "Dry Cleaning — Suits & Formal Wear",
      price: 450, costPrice: 180, deliveryCost: 0, stock: 9999, sold: 218,
      category: "laundry", location: "nairobi",
      description: "Professional dry cleaning for suits, blazers, dresses & delicates. Pressed & bagged. 24hr turnaround.",
      image: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=75",
      sellerName: "FreshPress Laundromat", sellerEmail: "freshpress@sokoni.ke",
      uploadedAt: daysAgo(2), views: 188, outOfStock: false, wishlistCount: 22, isService: true, kebsCert: ""
    },
    {
      id: uid("LN"), name: "Duvet & Blanket Deep Clean",
      price: 600, costPrice: 200, deliveryCost: 0, stock: 9999, sold: 143,
      category: "laundry", location: "nairobi",
      description: "Industrial wash for duvets (single/double/king), blankets & throws. Tumble-dried, folded & wrapped. Free pickup.",
      image: "https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=400&q=75",
      sellerName: "Mama Clean Laundry", sellerEmail: "mamaclean@sokoni.ke",
      uploadedAt: daysAgo(0), views: 156, outOfStock: false, wishlistCount: 19, isService: true, kebsCert: ""
    },
    {
      id: uid("LN"), name: "Curtains & Drapes Washing (Per Set)",
      price: 350, costPrice: 120, deliveryCost: 0, stock: 9999, sold: 97,
      category: "laundry", location: "nairobi",
      description: "Full wash & press for curtain sets. Re-hung on original rings. Same-week service. All sizes.",
      image: "https://images.unsplash.com/photo-1558618047-f4e80e1a2c3c?w=400&q=75",
      sellerName: "SpinClean Express", sellerEmail: "spinclean@sokoni.ke",
      uploadedAt: daysAgo(3), views: 89, outOfStock: false, wishlistCount: 11, isService: true, kebsCert: ""
    },
    {
      id: uid("LN"), name: "Shirt Ironing & Pressing (Per Piece)",
      price: 50, costPrice: 15, deliveryCost: 0, stock: 9999, sold: 812,
      category: "laundry", location: "nairobi",
      description: "Crisp professional pressing. Shirts, trousers, school uniforms. Min 5 pieces. Nairobi same-day.",
      image: "https://images.unsplash.com/photo-1559131583-f176a2eb61db?w=400&q=75",
      sellerName: "CleanFold by Jane", sellerEmail: "cleanfoldjane@sokoni.ke",
      uploadedAt: daysAgo(0), views: 334, outOfStock: false, wishlistCount: 38, isService: true, kebsCert: ""
    },
    {
      id: uid("LN"), name: "Weekly Office Laundry Package",
      price: 4500, costPrice: 1800, deliveryCost: 0, stock: 9999, sold: 56,
      category: "laundry", location: "nairobi",
      description: "Weekly collection & delivery for offices. Uniforms, aprons, linen. Up to 20 kg/week. Invoice available.",
      image: "https://images.unsplash.com/photo-1604335399105-a0c585fd81a1?w=400&q=75",
      sellerName: "FreshPress Laundromat", sellerEmail: "freshpress@sokoni.ke",
      uploadedAt: daysAgo(4), views: 201, outOfStock: false, wishlistCount: 14, isService: true, kebsCert: ""
    }
  ];

  /* ── CAR LISTINGS (buy & sell) ── */
  const CAR_LISTINGS = [
    { id:uid("CAR"), name:"Toyota Land Cruiser V8 2018", price:5800000, category:"cars", location:"nairobi",
      description:"Full option, 7-seater, black interior. 78,000km. Original paint. Stamped service book. Trade-in considered.",
      image:"https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?w=400&q=70",
      sellerName:"AutoMart Kenya", sellerEmail:"automart@sokoni.ke",
      uploadedAt:daysAgo(2), views:312, outOfStock:false, wishlistCount:24,
      carYear:2018, carMileage:"78,000 km", carCondition:"Foreign Used", carTransmission:"Automatic", carFuel:"Diesel" },
    { id:uid("CAR"), name:"Mercedes-Benz C200 2020", price:4200000, category:"cars", location:"nairobi",
      description:"Low mileage, full-spec, panoramic roof, leather seats. One careful owner. Clean logbook.",
      image:"https://images.unsplash.com/photo-1605559424843-9e4c228bf1c2?w=400&q=70",
      sellerName:"Prestige Motors", sellerEmail:"prestige@sokoni.ke",
      uploadedAt:daysAgo(1), views:289, outOfStock:false, wishlistCount:31,
      carYear:2020, carMileage:"42,000 km", carCondition:"Foreign Used", carTransmission:"Automatic", carFuel:"Petrol" },
    { id:uid("CAR"), name:"Subaru Forester 2016 XT Turbo", price:1850000, category:"cars", location:"nairobi",
      description:"Turbo engine, AWD, sunroof. Accident-free. Recently serviced. NTSA inspection done.",
      image:"https://images.unsplash.com/photo-1609521263047-f8f205293f24?w=400&q=70",
      sellerName:"Kenya Motors Hub", sellerEmail:"kmhub@sokoni.ke",
      uploadedAt:daysAgo(3), views:198, outOfStock:false, wishlistCount:18,
      carYear:2016, carMileage:"112,000 km", carCondition:"Locally Used", carTransmission:"Automatic", carFuel:"Petrol" },
    { id:uid("CAR"), name:"Toyota Hilux Double Cab 2019", price:3500000, category:"cars", location:"nairobi",
      description:"4x4, diesel, bull bar, cargo cover. Used in construction — solid machine. Log book clean.",
      image:"https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=70",
      sellerName:"Heavy Duty Autos", sellerEmail:"hda@sokoni.ke",
      uploadedAt:daysAgo(4), views:245, outOfStock:false, wishlistCount:22,
      carYear:2019, carMileage:"95,000 km", carCondition:"Locally Used", carTransmission:"Manual", carFuel:"Diesel" },
    { id:uid("CAR"), name:"Nissan Note 2014 (New Shape)", price:780000, category:"cars", location:"nairobi",
      description:"Super clean, low fuel. Perfect city car. New tyres, new battery. No accidents.",
      image:"https://images.unsplash.com/photo-1621135786427-4b21cfe2f4e6?w=400&q=70",
      sellerName:"Budget Cars KE", sellerEmail:"budgetcars@sokoni.ke",
      uploadedAt:daysAgo(1), views:156, outOfStock:false, wishlistCount:41,
      carYear:2014, carMileage:"64,000 km", carCondition:"Foreign Used", carTransmission:"Automatic", carFuel:"Petrol" },
    { id:uid("CAR"), name:"Isuzu D-Max 2021 LS", price:4100000, category:"cars", location:"mombasa",
      description:"2021 model, hardtop cover, leather seats. 4WD. Perfect for coastal roads. Full service history.",
      image:"https://images.unsplash.com/photo-1571987502227-9231b837d92a?w=400&q=70",
      sellerName:"Coast Auto Dealers", sellerEmail:"coast@sokoni.ke",
      uploadedAt:daysAgo(5), views:178, outOfStock:false, wishlistCount:15,
      carYear:2021, carMileage:"38,000 km", carCondition:"Foreign Used", carTransmission:"Automatic", carFuel:"Diesel" },
    { id:uid("CAR"), name:"Honda Fit 2013 Jazz", price:680000, category:"cars", location:"nairobi",
      description:"Lady-owned, excellent condition. Magic seat, full music system. Very economical.",
      image:"https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=400&q=70",
      sellerName:"Jomoko Motors", sellerEmail:"jomoko@sokoni.ke",
      uploadedAt:daysAgo(2), views:134, outOfStock:false, wishlistCount:28,
      carYear:2013, carMileage:"72,000 km", carCondition:"Foreign Used", carTransmission:"Automatic", carFuel:"Petrol" },
    { id:uid("CAR"), name:"VW Tiguan 2017 Highline", price:2950000, category:"cars", location:"nairobi",
      description:"Turbocharged, panoramic roof, DSG gearbox. Full spec. Must see to appreciate.",
      image:"https://images.unsplash.com/photo-1619767886558-efdc259b6e09?w=400&q=70",
      sellerName:"German Auto KE", sellerEmail:"germanauto@sokoni.ke",
      uploadedAt:daysAgo(3), views:201, outOfStock:false, wishlistCount:19,
      carYear:2017, carMileage:"58,000 km", carCondition:"Foreign Used", carTransmission:"Automatic", carFuel:"Petrol" },
  ];
  PRODUCTS.push(...CAR_LISTINGS);

  localStorage.setItem("sellerProducts", JSON.stringify(PRODUCTS));

  /* ═══════════════════════════════════════════════════════════
     2. FLASH SALES  (3 active deals)
  ═══════════════════════════════════════════════════════════ */
  const FLASH = [
    { productId: PRODUCTS[0].id,  discount: 15, endsAt: daysAhead(0) + 18 * HR, createdAt: NOW },
    { productId: PRODUCTS[7].id,  discount: 20, endsAt: daysAhead(0) + 6  * HR, createdAt: NOW },
    { productId: PRODUCTS[18].id, discount: 12, endsAt: daysAhead(1),            createdAt: NOW },
    { productId: PRODUCTS[30].id, discount: 25, endsAt: daysAhead(0) + 10 * HR, createdAt: NOW }
  ];
  localStorage.setItem("sokoniFlashSales", JSON.stringify(FLASH));

  /* ═══════════════════════════════════════════════════════════
     3. ORDERS  (3 realistic orders for track/invoice demo)
  ═══════════════════════════════════════════════════════════ */
  const ORDERS = [
    {
      id: "SKN" + String(daysAgo(2)).slice(-6),
      items: [PRODUCTS[6], PRODUCTS[23]],
      total: 4330, phone: "254712345678", method: "mpesa",
      name: "Demo User", address: "Westlands, Nairobi",
      date: new Date(daysAgo(2)).toLocaleDateString("en-KE",{day:"numeric",month:"short",year:"numeric"}),
      timestamp: daysAgo(2), status: "delivered",
      steps: [
        {label:"Order Placed",done:true,time:"09:00"},
        {label:"Processing",done:true,time:"09:05"},
        {label:"Shipped",done:true,time:"11:30"},
        {label:"Out for Delivery",done:true,time:"14:00"},
        {label:"Delivered",done:true,time:"16:20"}
      ]
    },
    {
      id: "SKN" + String(daysAgo(1)).slice(-6),
      items: [PRODUCTS[0], PRODUCTS[15]],
      total: 54200, phone: "254798765432", method: "card",
      name: "Demo User", address: "Kilimani, Nairobi",
      date: new Date(daysAgo(1)).toLocaleDateString("en-KE",{day:"numeric",month:"short",year:"numeric"}),
      timestamp: daysAgo(1), status: "shipped",
      steps: [
        {label:"Order Placed",done:true,time:"08:15"},
        {label:"Processing",done:true,time:"08:30"},
        {label:"Shipped",done:true,time:"13:45"},
        {label:"Out for Delivery",done:false,time:""},
        {label:"Delivered",done:false,time:""}
      ]
    },
    {
      id: "SKN" + String(NOW).slice(-6),
      items: [PRODUCTS[36]],
      total: 2500, phone: "254700111222", method: "mpesa",
      name: "Demo User", address: "CBD, Nairobi",
      date: new Date(NOW).toLocaleDateString("en-KE",{day:"numeric",month:"short",year:"numeric"}),
      timestamp: NOW, status: "processing",
      steps: [
        {label:"Order Placed",done:true,time:"10:00"},
        {label:"Processing",done:true,time:"10:01"},
        {label:"Shipped",done:false,time:""},
        {label:"Out for Delivery",done:false,time:""},
        {label:"Delivered",done:false,time:""}
      ]
    }
  ];
  localStorage.setItem("sokoniOrders", JSON.stringify(ORDERS));

  /* ═══════════════════════════════════════════════════════════
     4. LOYALTY POINTS
  ═══════════════════════════════════════════════════════════ */
  localStorage.setItem("sokoniPoints", JSON.stringify({
    total: 1240,
    history: [
      { points: 780, orderId: ORDERS[0].id, date: ORDERS[0].date, description: "Purchase reward" },
      { points: 321, orderId: ORDERS[1].id, date: ORDERS[1].date, description: "Purchase reward" },
      { points:  99, orderId: ORDERS[2].id, date: ORDERS[2].date, description: "Purchase reward" },
      { points:  40, orderId: "SKN_REF001",  date: "26 May 2026",  description: "Referral bonus" }
    ]
  }));

  /* ═══════════════════════════════════════════════════════════
     5. SELLER RATINGS
  ═══════════════════════════════════════════════════════════ */
  const RATINGS = {
    "Sokoni Electronics": [
      { stars:5, avgScore:4.8, comment:"Fast delivery, genuine product!", buyerName:"Brian K.", date:"20 May 2026", timestamp:daysAgo(3) },
      { stars:4, avgScore:4.2, comment:"Great seller, minor delay.", buyerName:"Grace W.", date:"18 May 2026", timestamp:daysAgo(5) },
      { stars:5, avgScore:5.0, comment:"Samsung TV exactly as shown, wall bracket included — impressed!", buyerName:"Moses A.", date:"25 May 2026", timestamp:daysAgo(1) }
    ],
    "KenShop": [
      { stars:5, avgScore:5.0, comment:"Exactly as described. Love it!", buyerName:"Aisha M.", date:"19 May 2026", timestamp:daysAgo(4) },
      { stars:4, avgScore:4.5, comment:"Kids shoes very durable, bought 3 pairs!", buyerName:"Cynthia O.", date:"22 May 2026", timestamp:daysAgo(2) }
    ],
    "Kaspa Prints": [
      { stars:5, avgScore:4.9, comment:"Quality print, fast turnaround!", buyerName:"Kevin O.", date:"21 May 2026", timestamp:daysAgo(2) },
      { stars:5, avgScore:5.0, comment:"Did my whole company uniform here!", buyerName:"James N.", date:"15 May 2026", timestamp:daysAgo(8) },
      { stars:5, avgScore:4.9, comment:"Flex banners for my event were stunning. Will come back!", buyerName:"Linda K.", date:"28 May 2026", timestamp:daysAgo(0) }
    ],
    "Green Farm Kenya": [
      { stars:5, avgScore:5.0, comment:"Freshest avocados I've ever bought online. Same day!", buyerName:"Mary W.", date:"29 May 2026", timestamp:daysAgo(0) },
      { stars:5, avgScore:4.9, comment:"Veg hamper is packed well, very fresh!", buyerName:"Peter K.", date:"27 May 2026", timestamp:daysAgo(1) }
    ],
    "Creative Hub KE": [
      { stars:5, avgScore:5.0, comment:"Logo design blew my mind. 3 amazing concepts!", buyerName:"Daniel M.", date:"24 May 2026", timestamp:daysAgo(2) },
      { stars:5, avgScore:4.9, comment:"Website done in 6 days, exceeded expectations!", buyerName:"Sarah J.", date:"21 May 2026", timestamp:daysAgo(5) }
    ],
    "Mama Clean Laundry": [
      { stars:5, avgScore:5.0, comment:"Unbelievably clean! Sent 10kg of mixed clothes, got them back same day — fresh, folded and sorted by colour!", buyerName:"Lilian N.", date:"28 May 2026", timestamp:daysAgo(0) },
      { stars:5, avgScore:4.9, comment:"My duvets have never smelled this good. Free pickup too — total convenience.", buyerName:"Samuel K.", date:"25 May 2026", timestamp:daysAgo(3) },
      { stars:5, avgScore:5.0, comment:"Uses eco-friendly detergents, perfect for my baby's clothes. Will use every week!", buyerName:"Eunice W.", date:"22 May 2026", timestamp:daysAgo(5) }
    ],
    "FreshPress Laundromat": [
      { stars:5, avgScore:4.9, comment:"Brought in my entire office uniform batch — 30 pieces pressed spotlessly. Professional service!", buyerName:"James M.", date:"27 May 2026", timestamp:daysAgo(1) },
      { stars:4, avgScore:4.5, comment:"Dry cleaned my suits perfectly. Took 24hrs as promised. Will be back.", buyerName:"Mike O.", date:"19 May 2026", timestamp:daysAgo(9) },
      { stars:5, avgScore:5.0, comment:"Curtains look brand new! They re-hung them on the rings too. Worth every shilling.", buyerName:"Priya S.", date:"23 May 2026", timestamp:daysAgo(5) }
    ],
    "SpinClean Express": [
      { stars:5, avgScore:4.8, comment:"Express 4-hour service is real! Sent uniforms at 9am, got them at 1pm. Amazing in Mombasa!", buyerName:"Hassan A.", date:"26 May 2026", timestamp:daysAgo(2) },
      { stars:4, avgScore:4.4, comment:"Good quality wash. Hotel linen service is excellent, reliable for our BnB.", buyerName:"Ruth K.", date:"20 May 2026", timestamp:daysAgo(8) }
    ],
    "CleanFold by Jane": [
      { stars:5, avgScore:5.0, comment:"My school shirts look like they've been ironed at a dry cleaner. Jane is amazing — 20 pieces done overnight!", buyerName:"Carolyn M.", date:"29 May 2026", timestamp:daysAgo(0) },
      { stars:5, avgScore:4.9, comment:"The most affordable pressing in Kasarani. KES 50 per piece and the quality is top!", buyerName:"Dennis O.", date:"24 May 2026", timestamp:daysAgo(4) },
      { stars:5, avgScore:5.0, comment:"She comes to pick up at home. My kids' uniforms are the neatest in class now 😄", buyerName:"Faith N.", date:"21 May 2026", timestamp:daysAgo(7) }
    ]
  };
  localStorage.setItem("sokoniSellerRatings", JSON.stringify(RATINGS));

  /* ═══════════════════════════════════════════════════════════
     6. PRODUCT RATINGS
  ═══════════════════════════════════════════════════════════ */
  const PROD_RATINGS = {};
  PRODUCTS.forEach((p, i) => {
    PROD_RATINGS[p.id] = [
      { stars: i % 3 === 0 ? 5 : i % 3 === 1 ? 4 : 5, orderId: ORDERS[0]?.id, timestamp: daysAgo(i + 1) }
    ];
  });
  localStorage.setItem("sokoniRatings", JSON.stringify(PROD_RATINGS));

  /* ═══════════════════════════════════════════════════════════
     7. REVIEWS  (platform reviews)
  ═══════════════════════════════════════════════════════════ */
  localStorage.setItem("sokoniReviews", JSON.stringify([
    { id:"r1", type:"platform", name:"Brian Kamau", rating:5, comment:"Sokoni is amazing! Got my electronics in 2 hours. Fast delivery and great prices.", date:"21 May 2026", timestamp:daysAgo(2) },
    { id:"r2", type:"platform", name:"Grace Wambui", rating:5, comment:"Best online marketplace in Kenya. Very easy to use and the sellers are legit.", date:"20 May 2026", timestamp:daysAgo(3) },
    { id:"r3", type:"platform", name:"James Otieno", rating:4, comment:"Great platform! Bought fashion items and they were exactly as described. Will shop again.", date:"19 May 2026", timestamp:daysAgo(4) },
    { id:"r4", type:"platform", name:"Fatuma Ali", rating:5, comment:"Ordered medicine through Healthcare Hub, arrived in 1.5 hours! Incredible service.", date:"18 May 2026", timestamp:daysAgo(5) },
    { id:"r5", type:"platform", name:"Daniel Mwangi", rating:5, comment:"Booked a DJ for my wedding through Entertainment Hub — he was phenomenal. Worth every shilling!", date:"17 May 2026", timestamp:daysAgo(6) },
    { id:"r6", type:"platform", name:"Mercy Achieng", rating:5, comment:"Used the catering service for my corporate event. Chef was professional, food was incredible!", date:"27 May 2026", timestamp:daysAgo(1) },
    { id:"r7", type:"platform", name:"Tom Kariuki", rating:5, comment:"Found my rental apartment through the Landlord Hub. Moved in within a week!", date:"26 May 2026", timestamp:daysAgo(2) },
    { id:"r8", type:"platform", name:"Naomi Wanjiru", rating:5, comment:"The BnB listings are top quality. Booked a Mombasa stay — it was everything the listing promised!", date:"25 May 2026", timestamp:daysAgo(3) },
    { id:"r9", type:"platform", name:"Lilian Njeri", rating:5, comment:"Mama Clean Laundry through Sokoni Services is a GAME CHANGER. Pickup + same-day delivery, 10 kg sorted and folded. Never going back to hand-washing!", date:"28 May 2026", timestamp:daysAgo(0) },
    { id:"r10", type:"platform", name:"James Muthoni", rating:5, comment:"FreshPress Laundromat did my entire office uniform order — 30 pressed shirts delivered next morning. Sokoni makes finding quality laundry so easy!", date:"27 May 2026", timestamp:daysAgo(1) }
  ]));

  /* ═══════════════════════════════════════════════════════════
     8. MESSAGES  (inbox demo)
  ═══════════════════════════════════════════════════════════ */
  const MSGS = [
    {
      id: "conv_001",
      productName: "Samsung Galaxy A55 5G",
      sellerName: "Sokoni Electronics",
      messages: [
        { sender:"seller", text:"Hi! Thanks for your interest in the Galaxy A55. Available & can be delivered same day in Nairobi!", time:"10:30" },
        { sender:"buyer",  text:"Yes please! What's the warranty?", time:"10:32" },
        { sender:"seller", text:"1 year manufacturer warranty, sealed in box. Delivery today for an extra KES 200 😊", time:"10:34" }
      ],
      unread: 1, spam: false, createdAt: daysAgo(1)
    },
    {
      id: "conv_002",
      productName: "Custom T-Shirt Printing",
      sellerName: "Kaspa Prints",
      messages: [
        { sender:"seller", text:"Welcome to Kaspa Prints! We print in 24hrs. Min 1 piece. Send your artwork or let us design for you!", time:"09:15" },
        { sender:"buyer",  text:"I need 50 branded polos for my company", time:"09:20" },
        { sender:"seller", text:"Perfect! Embroidery or print? Send us the logo and we'll quote you same day. 50 pieces = 10% group discount 🔥", time:"09:22" }
      ],
      unread: 0, spam: false, createdAt: daysAgo(2)
    },
    {
      id: "conv_catering",
      productName: "Corporate Event Catering",
      sellerName: "Tasty Events Catering",
      messages: [
        { sender:"seller", text:"Hello! Thank you for reaching out. We handle corporate events, weddings & private dinners. What's your event date & guest count?", time:"14:00" },
        { sender:"buyer",  text:"I need catering for 80 guests, office party on Friday", time:"14:05" },
        { sender:"seller", text:"Perfect! We can handle 80 guests comfortably. We offer buffet or plated service. Menu options: Kenyan, Continental or Mix. Shall I send you our corporate menu?", time:"14:08" }
      ],
      unread: 1, spam: false, createdAt: daysAgo(0)
    },
    {
      id: "conv_welcome",
      productName: "Welcome to Sokoni! 🎉",
      sellerName: "Sokoni Team",
      messages: [
        { sender:"seller", text:"Hi there! 👋 Welcome to SOKONI — Kenya's global marketplace!\n\n✅ Your account is ready\n⭐ Earn points on every purchase\n📦 Track orders in real-time\n💬 Chat with sellers directly\n🎥 Watch seller stories for deals\n🏠 Find BnBs & rental properties\n\nHappy shopping! 🛍️", time:"08:00" }
      ],
      unread: 1, spam: false, createdAt: daysAgo(0)
    },
    {
      id: "conv_laundry",
      productName: "Wash & Fold — Per Kg",
      sellerName: "Mama Clean Laundry",
      messages: [
        { sender:"seller", text:"Hi! 🧺 Thanks for reaching out to Mama Clean Laundry. We do same-day wash & fold at KES 80/kg. Free pickup anywhere in Nairobi. Minimum 3kg. What can we help you with?", time:"07:45" },
        { sender:"buyer",  text:"I have about 8kg of mixed clothes including school uniforms. Can you pick up today?", time:"07:50" },
        { sender:"seller", text:"Absolutely! 8kg = KES 640. Our rider can pick up from you before 10am and deliver by 5pm today. Please share your location and we'll confirm the pickup. We use eco-friendly detergents — great for kids' uniforms! 🌿", time:"07:53" }
      ],
      unread: 1, spam: false, createdAt: daysAgo(0)
    }
  ];
  localStorage.setItem("sokoniMessages", JSON.stringify(MSGS));

  /* ═══════════════════════════════════════════════════════════
     9. SERVICE PROVIDERS  — incl. catering & chefs
  ═══════════════════════════════════════════════════════════ */
  const PROVIDERS = [
    {
      id: "SP001", name: "James Kamau", phone: "0712345678",
      category: "plumbing", skills: ["Pipe fitting","Leak repair","Water heater install","Drainage"],
      location: "Nairobi", area: "Westlands, Kilimani, CBD",
      rate: 500, rateType: "hourly", bio: "Licensed plumber with 10+ years experience. Available 7 days.",
      rating: 4.8, jobsCompleted: 127, available: true, verified: true, createdAt: daysAgo(30)
    },
    {
      id: "SP002", name: "Grace Nyambura", phone: "0798765432",
      category: "cleaning", skills: ["Deep cleaning","Move-in/out clean","Office clean","Carpet wash"],
      location: "Nairobi", area: "All Nairobi",
      rate: 1500, rateType: "per job", bio: "Professional cleaner, team of 3. Same day available.",
      rating: 4.9, jobsCompleted: 89, available: true, verified: true, createdAt: daysAgo(25)
    },
    {
      id: "SP003", name: "Kevin Ochieng", phone: "0700111222",
      category: "electrical", skills: ["Wiring","Solar installation","Meter reading","Bulb replacement"],
      location: "Nairobi", area: "Nairobi & Kiambu",
      rate: 600, rateType: "hourly", bio: "ERC licensed electrician. Residential & commercial.",
      rating: 4.7, jobsCompleted: 203, available: true, verified: true, createdAt: daysAgo(20)
    },
    {
      id: "SP004", name: "Aisha Mohamed", phone: "0722333444",
      category: "graphic-design", skills: ["Logo design","Branding","Social media graphics","Packaging"],
      location: "remote", area: "Kenya-wide",
      rate: 2500, rateType: "per project", bio: "5 years in brand design. Portfolio on request. 48hr delivery.",
      rating: 5.0, jobsCompleted: 156, available: true, verified: true, createdAt: daysAgo(15)
    },
    {
      id: "SP005", name: "Daniel Njoroge", phone: "0733444555",
      category: "phone-repair", skills: ["Screen replacement","Battery replace","Water damage","Software repair"],
      location: "Nairobi", area: "CBD & Westlands",
      rate: 800, rateType: "per job", bio: "All brands. 90-day warranty on parts. Walk-in or pickup.",
      rating: 4.6, jobsCompleted: 341, available: true, verified: false, createdAt: daysAgo(10)
    },
    {
      id: "SP006", name: "Sarah Wanjiku", phone: "0744555666",
      category: "tutoring", skills: ["KCSE Math","Physics","Chemistry","English","IELTS prep"],
      location: "Nairobi", area: "Nairobi, Online",
      rate: 800, rateType: "per hour", bio: "B.Ed holder. 8 years tutoring. Proven results.",
      rating: 4.9, jobsCompleted: 68, available: true, verified: true, createdAt: daysAgo(8)
    },
    /* ── CATERING & CHEFS ── */
    {
      id: "SP007", name: "Chef Mary Njeri", phone: "0755666777",
      category: "catering", skills: ["Private dinner chef","Kenyan cuisine","Continental","BBQ & grills","Pastries & cakes"],
      location: "Nairobi", area: "Nairobi & surroundings",
      rate: 5000, rateType: "per event", bio: "Culinary Institute graduate. 12 years private chef experience. Can handle 2–200 guests. Halal & vegan menus available.",
      rating: 5.0, jobsCompleted: 218, available: true, verified: true, createdAt: daysAgo(60)
    },
    {
      id: "SP008", name: "Tasty Events Catering", phone: "0766777888",
      category: "catering", skills: ["Corporate buffet","Wedding receptions","Birthday parties","Office lunches","Outdoor events"],
      location: "Nairobi", area: "Nairobi & Kiambu",
      rate: 350, rateType: "per person", bio: "Full-service catering company. Team of 8. Own equipment, décor & waitstaff. Min 20 guests.",
      rating: 4.9, jobsCompleted: 312, available: true, verified: true, createdAt: daysAgo(45)
    },
    {
      id: "SP009", name: "Chef Kofi Mensah", phone: "0777888999",
      category: "catering", skills: ["BBQ master","Nyama choma","Roast chicken","Continental grills","Live cooking station"],
      location: "Nairobi", area: "Nairobi wide",
      rate: 8000, rateType: "per event", bio: "Specialises in live BBQ stations & roasts. Equipment own. Fan favourite for corporate & family events.",
      rating: 4.8, jobsCompleted: 145, available: true, verified: true, createdAt: daysAgo(35)
    },
    {
      id: "SP010", name: "Mama Pima Kitchen", phone: "0711000222",
      category: "catering", skills: ["Kenyan home meals","Ugali & stews","Budget office catering","Mandazi & chai","School tuck shop"],
      location: "Nairobi", area: "Nairobi CBD & Eastlands",
      rate: 180, rateType: "per person", bio: "Authentic Kenyan home cooking for offices & events. Loved by 500+ repeat clients. Order by 8 AM for lunch delivery.",
      rating: 4.7, jobsCompleted: 891, available: true, verified: true, createdAt: daysAgo(90)
    },
    {
      id: "SP011", name: "Chef Amina Hassan", phone: "0722111333",
      category: "catering", skills: ["Swahili cuisine","Biryani & pilau","Wedding catering","Halal certified","Coastal seafood"],
      location: "Mombasa", area: "Mombasa, Kilifi, Malindi",
      rate: 400, rateType: "per person", bio: "Certified halal caterer. Specialises in coastal Swahili cuisine & Indian Ocean flavours. Weddings & events.",
      rating: 5.0, jobsCompleted: 176, available: true, verified: true, createdAt: daysAgo(50)
    },
    {
      id: "SP012", name: "Elegant Bakes & Pastries", phone: "0733222444",
      category: "catering", skills: ["Wedding cakes","Corporate cakes","Cupcakes","Pastries","Dessert tables"],
      location: "Nairobi", area: "Nairobi & online orders",
      rate: 3500, rateType: "per order", bio: "Custom cakes & pastries for any occasion. 48hr order. Delivery available. Instagram: @elegantbakesKE",
      rating: 4.9, jobsCompleted: 423, available: true, verified: true, createdAt: daysAgo(40)
    },
    /* ── EVENTS ── */
    {
      id: "SP013", name: "Starlight Events KE", phone: "0744333555",
      category: "events", skills: ["Event planning","Décor & flowers","MC services","Sound & lighting","Photography"],
      location: "Nairobi", area: "Kenya-wide",
      rate: 25000, rateType: "per event", bio: "Full-service event planning. Weddings, corporate, birthdays. We handle everything from concept to cleanup.",
      rating: 4.9, jobsCompleted: 87, available: true, verified: true, createdAt: daysAgo(55)
    },
    /* ── HAIR & BEAUTY ── */
    {
      id: "SP014", name: "Glam Studio by Winnie", phone: "0755444666",
      category: "hair-beauty", skills: ["Braids & locs","Weaves","Natural hair","Makeup","Nail art"],
      location: "Nairobi", area: "Westlands & home visits",
      rate: 1200, rateType: "per service", bio: "Professional stylist. Home visits available. 10+ years experience. Organic products only.",
      rating: 5.0, jobsCompleted: 534, available: true, verified: true, createdAt: daysAgo(22)
    },
    /* ── LAUNDRY (MAMAFUA) ── */
    {
      id: "SP015", name: "Mama Clean Laundry", phone: "0700333444",
      category: "laundry", skills: ["Wash & fold","Duvet cleaning","Blankets","Baby clothes","Free pickup & delivery"],
      location: "Nairobi", area: "All Nairobi — free pickup",
      rate: 80, rateType: "per kg", bio: "Nairobi's most trusted mamafua. Industrial washing machines, eco-friendly detergents. Same-day service. 1,000+ happy clients.",
      rating: 4.9, jobsCompleted: 1042, available: true, verified: true, createdAt: daysAgo(120)
    },
    {
      id: "SP016", name: "FreshPress Laundromat", phone: "0711444555",
      category: "laundry", skills: ["Dry cleaning","Suits & formals","Curtains","Office linen","Weekly packages"],
      location: "Nairobi", area: "CBD, Westlands, Kilimani, Karen",
      rate: 450, rateType: "per item", bio: "Professional dry cleaning & laundry centre. State-of-the-art equipment. Suits, curtains, duvets, office contracts. Open 7 days.",
      rating: 4.8, jobsCompleted: 678, available: true, verified: true, createdAt: daysAgo(90)
    },
    {
      id: "SP017", name: "SpinClean Express", phone: "0733555666",
      category: "laundry", skills: ["Express wash","Curtains & drapes","Uniform wash","Stain removal","Same-day delivery"],
      location: "Mombasa", area: "Mombasa Island & Nyali",
      rate: 70, rateType: "per kg", bio: "Mombasa's fastest laundry. 4-hour express service. Specialises in hotel & BnB linen, uniforms and home laundry. Certified.",
      rating: 4.7, jobsCompleted: 389, available: true, verified: true, createdAt: daysAgo(65)
    },
    {
      id: "SP018", name: "CleanFold by Jane", phone: "0722666777",
      category: "laundry", skills: ["Ironing & pressing","Shirts","School uniforms","Delicates","Home visits"],
      location: "Nairobi", area: "Kasarani, Roysambu, Thika Rd",
      rate: 50, rateType: "per piece", bio: "Specialised ironing & pressing service. Home collection. Shirts, trousers, school uniforms. Minimum 5 pieces. Neat & crisp guaranteed.",
      rating: 4.9, jobsCompleted: 2301, available: true, verified: false, createdAt: daysAgo(40)
    }
  ];
  localStorage.setItem("sokoniServiceProviders", JSON.stringify(PROVIDERS));

  /* ═══════════════════════════════════════════════════════════
     10. SERVICE BOOKINGS
  ═══════════════════════════════════════════════════════════ */
  localStorage.setItem("sokoniServiceBookings", JSON.stringify([
    {
      id: "BK001", providerId: "SP001", providerName: "James Kamau",
      clientName: "Brian K.", clientPhone: "0787654321",
      category: "plumbing", jobDesc: "Kitchen sink leaking badly",
      location: "Kileleshwa, Nairobi",
      scheduledDate: new Date(daysAhead(1)).toISOString().slice(0,10),
      scheduledTime: "09:00", status: "confirmed", quote: 1500,
      createdAt: daysAgo(1), updatedAt: NOW
    },
    {
      id: "BK002", providerId: "SP002", providerName: "Grace Nyambura",
      clientName: "Amina Hassan", clientPhone: "0711222333",
      category: "cleaning", jobDesc: "Moving into new apartment, need full deep clean",
      location: "Westlands, Nairobi",
      scheduledDate: new Date(daysAhead(2)).toISOString().slice(0,10),
      scheduledTime: "08:00", status: "pending", quote: 0,
      createdAt: NOW, updatedAt: NOW
    },
    {
      id: "BK003", providerId: "SP007", providerName: "Chef Mary Njeri",
      clientName: "Mercy A.", clientPhone: "0700444555",
      category: "catering", jobDesc: "Private dinner for 12 guests — anniversary celebration",
      location: "Karen, Nairobi",
      scheduledDate: new Date(daysAhead(3)).toISOString().slice(0,10),
      scheduledTime: "17:00", status: "confirmed", quote: 12000,
      createdAt: daysAgo(2), updatedAt: NOW
    },
    {
      id: "BK004", providerId: "SP008", providerName: "Tasty Events Catering",
      clientName: "TechCorp Ltd", clientPhone: "0722999111",
      category: "catering", jobDesc: "Corporate team lunch for 80 staff — quarterly meeting",
      location: "Upper Hill, Nairobi",
      scheduledDate: new Date(daysAhead(5)).toISOString().slice(0,10),
      scheduledTime: "12:00", status: "confirmed", quote: 28000,
      createdAt: daysAgo(1), updatedAt: NOW
    },
    {
      id: "BK005", providerId: "SP015", providerName: "Mama Clean Laundry",
      clientName: "Eunice Wanjiru", clientPhone: "0788100200",
      category: "laundry", jobDesc: "8kg mixed clothes + 2 school uniforms — same-day wash & fold",
      location: "Kasarani, Nairobi",
      scheduledDate: new Date(NOW).toISOString().slice(0,10),
      scheduledTime: "09:00", status: "in_progress", quote: 640,
      createdAt: daysAgo(0), updatedAt: NOW
    },
    {
      id: "BK006", providerId: "SP016", providerName: "FreshPress Laundromat",
      clientName: "Apex Office Ltd", clientPhone: "0733200300",
      category: "laundry", jobDesc: "Weekly office laundry — 25 staff uniforms, pressed & delivered every Monday",
      location: "Upperhill, Nairobi",
      scheduledDate: new Date(daysAhead(2)).toISOString().slice(0,10),
      scheduledTime: "08:00", status: "confirmed", quote: 4500,
      createdAt: daysAgo(1), updatedAt: NOW
    }
  ]));

  /* ═══════════════════════════════════════════════════════════
     11. BnB LISTINGS  (8 listings across Kenya)
  ═══════════════════════════════════════════════════════════ */
  localStorage.setItem("sokoniBnBListings", JSON.stringify([
    {
      id: "BNB001", hostName: "James Kamau", hostPhone: "0712345678",
      title: "Cozy Studio in Westlands", type: "studio",
      location: "Westlands, Nairobi", pricePerNight: 2500,
      rating: 4.7, reviewCount: 23, maxGuests: 2, bedrooms: 1, bathrooms: 1,
      amenities: ["WiFi","AC","Parking","Kitchen","Security"],
      description: "Modern studio, 5min walk to Sarit Centre. Clean & quiet neighborhood.",
      image: "https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?w=400&q=75",
      available: true, createdAt: daysAgo(30)
    },
    {
      id: "BNB002", hostName: "Amina Hassan", hostPhone: "0711222333",
      title: "Mombasa Nyali Beach Apartment", type: "apartment",
      location: "Nyali, Mombasa", pricePerNight: 4500,
      rating: 4.9, reviewCount: 41, maxGuests: 4, bedrooms: 2, bathrooms: 1,
      amenities: ["WiFi","Pool","Beach access","Parking","AC","DSTV"],
      description: "Sea-view 2BR. 5 min walk to Nyali Beach. Perfect for a holiday retreat.",
      image: "https://images.unsplash.com/photo-1582719508461-905c673771fd?w=400&q=75",
      available: true, createdAt: daysAgo(20)
    },
    {
      id: "BNB003", hostName: "Sarah Mwende", hostPhone: "0733111222",
      title: "Budget Bedsitter — Kisumu City", type: "bedsitter",
      location: "Milimani, Kisumu", pricePerNight: 1200,
      rating: 4.3, reviewCount: 12, maxGuests: 1, bedrooms: 1, bathrooms: 1,
      amenities: ["WiFi","Security","Water included"],
      description: "Clean and affordable. Near Kisumu CBD and Lake Victoria.",
      image: "https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=400&q=75",
      available: true, createdAt: daysAgo(15)
    },
    {
      id: "BNB004", hostName: "David Njeru", hostPhone: "0744222333",
      title: "Karen Luxury Villa (3BR)", type: "villa",
      location: "Karen, Nairobi", pricePerNight: 18000,
      rating: 5.0, reviewCount: 18, maxGuests: 8, bedrooms: 3, bathrooms: 3,
      amenities: ["WiFi","Pool","BBQ","Garden","Parking x4","Generator","Chef on request"],
      description: "Stunning 3BR villa in Karen. Private pool, manicured garden, full security. Ideal for executive retreats or family getaways.",
      image: "https://images.unsplash.com/photo-1613977257363-707ba9348227?w=400&q=75",
      available: true, createdAt: daysAgo(45)
    },
    {
      id: "BNB005", hostName: "Rose Kamau", hostPhone: "0755333444",
      title: "Nakuru Town Centre Room", type: "studio",
      location: "Nakuru CBD", pricePerNight: 900,
      rating: 4.1, reviewCount: 9, maxGuests: 2, bedrooms: 1, bathrooms: 1,
      amenities: ["WiFi","Hot water","TV","Security"],
      description: "Clean en-suite room in the heart of Nakuru. Close to all amenities.",
      image: "https://images.unsplash.com/photo-1611892440504-42a792e24d32?w=400&q=75",
      available: true, createdAt: daysAgo(10)
    },
    {
      id: "BNB006", hostName: "John Omondi", hostPhone: "0766444555",
      title: "Lakeside Cottage — Kisumu", type: "cottage",
      location: "Dunga Beach, Kisumu", pricePerNight: 5500,
      rating: 4.8, reviewCount: 27, maxGuests: 6, bedrooms: 2, bathrooms: 2,
      amenities: ["Lake view","WiFi","Fishing equipment","Boat hire","Outdoor fire pit","BBQ"],
      description: "Wake up to Lake Victoria views. Private cottage with direct lake access. Perfect for nature lovers & fishing enthusiasts.",
      image: "https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=400&q=75",
      available: true, createdAt: daysAgo(25)
    },
    {
      id: "BNB007", hostName: "Esther Mutua", hostPhone: "0777555666",
      title: "Malindi Beachfront Banda", type: "banda",
      location: "Malindi Beach, Kilifi", pricePerNight: 3800,
      rating: 4.9, reviewCount: 33, maxGuests: 4, bedrooms: 2, bathrooms: 1,
      amenities: ["Beach front","WiFi","AC","Outdoor shower","Hammock","Snorkeling gear"],
      description: "Stunning thatched banda right on Malindi's white sand beach. Fall asleep to the sound of the ocean.",
      image: "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=400&q=75",
      available: true, createdAt: daysAgo(18)
    },
    {
      id: "BNB008", hostName: "Collins Rutto", hostPhone: "0788666777",
      title: "Eldoret Student Hostel Room", type: "room",
      location: "Eldoret CBD", pricePerNight: 700,
      rating: 4.0, reviewCount: 7, maxGuests: 1, bedrooms: 1, bathrooms: 0,
      amenities: ["WiFi","Shared kitchen","Security","Laundry"],
      description: "Affordable clean room near Moi University & Eldoret CBD. Shared facilities. Ideal for students & budget travelers.",
      image: "https://images.unsplash.com/photo-1536376072261-38c75010e6c9?w=400&q=75",
      available: true, createdAt: daysAgo(5)
    }
  ]));

  /* ═══════════════════════════════════════════════════════════
     12. PROPERTY LISTINGS  — rental listings (8 properties)
  ═══════════════════════════════════════════════════════════ */
  localStorage.setItem("sokoniProperties_listings", JSON.stringify([
    {
      id: "PROP001", title: "2BR Apartment — Kilimani", type: "apartment",
      location: "Kilimani, Nairobi", rent: 35000, deposit: 70000, bedrooms: 2,
      leaseTerm: "12 months",
      description: "Modern 2BR, serviced. Includes water & security. Quiet compound.",
      amenities: ["Parking","CCTV","Borehole","Backup generator"],
      landlordName: "Kamau Properties", landlordPhone: "0712111222",
      available: true, createdAt: daysAgo(10)
    },
    {
      id: "PROP002", title: "Bedsitter — Thika Road", type: "bedsitter",
      location: "Kasarani, Nairobi", rent: 8500, deposit: 17000, bedrooms: 1,
      leaseTerm: "Month-to-month",
      description: "Self-contained bedsitter. Near Garden City Mall. Quiet block.",
      amenities: ["Security","WiFi-ready"],
      landlordName: "Grace Wangari", landlordPhone: "0798111222",
      available: true, createdAt: daysAgo(5)
    },
    {
      id: "PROP003", title: "3BR Townhouse — Karen", type: "townhouse",
      location: "Karen, Nairobi", rent: 95000, deposit: 190000, bedrooms: 3,
      leaseTerm: "12 months",
      description: "Spacious 3BR + DSQ. Private garden, 2 parking, borehole, solar. Gated estate.",
      amenities: ["Parking x2","DSQ","Garden","Borehole","Solar","CCTV","Pool access"],
      landlordName: "Karen Estates Ltd", landlordPhone: "0766111333",
      available: true, createdAt: daysAgo(7)
    },
    {
      id: "PROP004", title: "1BR Studio Apartment — Westlands", type: "studio",
      location: "Westlands, Nairobi", rent: 22000, deposit: 44000, bedrooms: 1,
      leaseTerm: "Month-to-month",
      description: "Furnished studio. 5 min to Westgate Mall. High-speed fibre, 24hr security.",
      amenities: ["Furnished","WiFi","Gym","Rooftop pool","Security"],
      landlordName: "Urban Nest Nairobi", landlordPhone: "0755222444",
      available: true, createdAt: daysAgo(3)
    },
    {
      id: "PROP005", title: "Commercial Shop — Mombasa CBD", type: "commercial",
      location: "Mombasa CBD", rent: 28000, deposit: 56000, bedrooms: 0,
      leaseTerm: "12 months",
      description: "Ground floor retail shop, 400sqft. High foot traffic street. Loading bay. Ideal for retail or restaurant.",
      amenities: ["Loading bay","24hr security","Water","3-phase power"],
      landlordName: "Coastal Properties KE", landlordPhone: "0711333555",
      available: true, createdAt: daysAgo(14)
    },
    {
      id: "PROP006", title: "Office Space — Upper Hill", type: "office",
      location: "Upper Hill, Nairobi", rent: 65000, deposit: 130000, bedrooms: 0,
      leaseTerm: "12 months",
      description: "Open plan 600sqft office. High-speed fibre, boardroom access, reception area, parking x2.",
      amenities: ["Fibre internet","Boardroom","Parking","Reception","Generator","AC"],
      landlordName: "Skyline Office Parks", landlordPhone: "0744444666",
      available: true, createdAt: daysAgo(6)
    },
    {
      id: "PROP007", title: "4BR Family Home — Lavington", type: "house",
      location: "Lavington, Nairobi", rent: 130000, deposit: 260000, bedrooms: 4,
      leaseTerm: "12 months",
      description: "All en-suite, servant quarters, large garden, carport x3. Peaceful cul-de-sac. Executive family home.",
      amenities: ["4 en-suite rooms","DSQ","Garden","Parking x3","Borehole","Generator","CCTV"],
      landlordName: "Executive Homes KE", landlordPhone: "0788555777",
      available: true, createdAt: daysAgo(4)
    },
    {
      id: "PROP008", title: "Serviced 1BR — Kilimani (AirBnB-style)", type: "serviced",
      location: "Kilimani, Nairobi", rent: 42000, deposit: 84000, bedrooms: 1,
      leaseTerm: "Month-to-month",
      description: "Fully furnished & serviced. Daily cleaning, linen change, meals on request. Perfect for corporate relocations.",
      amenities: ["Fully furnished","Daily cleaning","Pool","Gym","Restaurant","24hr reception"],
      landlordName: "Hive Residences", landlordPhone: "0733666888",
      available: true, createdAt: daysAgo(2)
    }
  ]));

  /* ═══════════════════════════════════════════════════════════
     13. STORIES  — rich seller stories (7 stories)
  ═══════════════════════════════════════════════════════════ */
  localStorage.setItem("sokoniStories", JSON.stringify([
    {
      id: "STR001", sellerName: "Kaspa Prints", sellerEmail: "kaspa@sokoni.ke",
      type: "photo",
      media: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&q=75",
      caption: "New hoodie designs just in! Check them out 🔥",
      ctaLink: "category.html?cat=printing",
      createdAt: NOW - 2 * HR, expiresAt: NOW + 22 * HR, views: 47, viewedBy: []
    },
    {
      id: "STR002", sellerName: "Sokoni Electronics", sellerEmail: "electronics@sokoni.ke",
      type: "photo",
      media: "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400&q=75",
      caption: "Galaxy A55 in stock — 15% off today only! ⚡",
      ctaLink: "flashsale.html",
      createdAt: NOW - 4 * HR, expiresAt: NOW + 20 * HR, views: 93, viewedBy: []
    },
    {
      id: "STR003", sellerName: "Chef Mary Njeri", sellerEmail: "marychef@sokoni.ke",
      type: "photo",
      media: "https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400&q=75",
      caption: "Just finished a private dinner for 12 — clients loved it! 👨‍🍳 Book your event now",
      ctaLink: "services.html?cat=catering",
      createdAt: NOW - 1 * HR, expiresAt: NOW + 23 * HR, views: 128, viewedBy: []
    },
    {
      id: "STR004", sellerName: "Tasty Events Catering", sellerEmail: "tastyevents@sokoni.ke",
      type: "photo",
      media: "https://images.unsplash.com/photo-1544025162-d76694265947?w=400&q=75",
      caption: "Corporate buffet setup 🍽️ 200 guests, zero complaints. Let us cater your next event!",
      ctaLink: "services.html?cat=catering",
      createdAt: NOW - 3 * HR, expiresAt: NOW + 21 * HR, views: 211, viewedBy: []
    },
    {
      id: "STR005", sellerName: "Glow Natural KE", sellerEmail: "glownaturalke@sokoni.ke",
      type: "photo",
      media: "https://images.unsplash.com/photo-1571781926291-c477ebfd024b?w=400&q=75",
      caption: "Skincare Sunday 🌿 Our organic set is back in stock. Limited quantity!",
      ctaLink: "category.html?cat=beauty",
      createdAt: NOW - 5 * HR, expiresAt: NOW + 19 * HR, views: 74, viewedBy: []
    },
    {
      id: "STR006", sellerName: "Green Farm Kenya", sellerEmail: "greenfarm@sokoni.ke",
      type: "photo",
      media: "https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&q=75",
      caption: "Fresh harvest just arrived! 🥕🥦 Veg hampers delivering today across Nairobi",
      ctaLink: "category.html?cat=food",
      createdAt: NOW - 30 * 60000, expiresAt: NOW + 23.5 * HR, views: 56, viewedBy: []
    },
    {
      id: "STR007", sellerName: "HomePlus Kenya", sellerEmail: "homeplus@sokoni.ke",
      type: "photo",
      media: "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400&q=75",
      caption: "WEEKEND DEAL: 7-seater sofa set KES 48,500 — delivery + assembly FREE 🛋️",
      ctaLink: "category.html?cat=furniture",
      createdAt: NOW - 6 * HR, expiresAt: NOW + 18 * HR, views: 163, viewedBy: []
    },
    {
      id: "STR008", sellerName: "Mama Clean Laundry", sellerEmail: "mamaclean@sokoni.ke",
      type: "photo",
      media: "https://images.unsplash.com/photo-1604335399105-a0c585fd81a1?w=400&q=75",
      caption: "🧺 Same-day wash & fold — KES 80/kg! Free pickup across Nairobi. Your clothes, sorted & fresh by 5pm 🌿",
      ctaLink: "services.html?cat=laundry",
      createdAt: NOW - 1.5 * HR, expiresAt: NOW + 22.5 * HR, views: 89, viewedBy: []
    },
    {
      id: "STR009", sellerName: "FreshPress Laundromat", sellerEmail: "freshpress@sokoni.ke",
      type: "photo",
      media: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&q=75",
      caption: "👔 Looking sharp costs less than you think. Dry cleaning from KES 450. Suits, curtains, office linen — done right!",
      ctaLink: "services.html?cat=laundry",
      createdAt: NOW - 3.5 * HR, expiresAt: NOW + 20.5 * HR, views: 61, viewedBy: []
    }
  ]));

  /* ═══════════════════════════════════════════════════════════
     14. COMMUNITY POSTS  (6 posts)
  ═══════════════════════════════════════════════════════════ */
  localStorage.setItem("sokoniCommunityPosts", JSON.stringify([
    {
      id: "CP001", author: "Brian K.", authorInitial: "B",
      text: "Just received my Samsung A55 from Sokoni Electronics — absolutely legit! Sealed box, 1yr warranty. Highly recommend 🙌",
      likes: 14, comments: 3, timestamp: daysAgo(1), category: "review"
    },
    {
      id: "CP002", author: "Mercy A.", authorInitial: "M",
      text: "Chef Mary Njeri catered my husband's 40th surprise dinner — 12 guests, 3-course meal. Every plate was perfection! 👨‍🍳⭐⭐⭐⭐⭐",
      likes: 29, comments: 7, timestamp: daysAgo(0), category: "review"
    },
    {
      id: "CP003", author: "Grace W.", authorInitial: "G",
      text: "Looking for a reliable plumber in Westlands. Anyone tried Sokoni Services? 🔧",
      likes: 2, comments: 5, timestamp: daysAgo(0), category: "request"
    },
    {
      id: "CP004", author: "Tom K.", authorInitial: "T",
      text: "Just moved into a 3BR Karen townhouse found through Sokoni Landlord Hub! Process was seamless — 4 days from listing to keys 🏠🔑",
      likes: 18, comments: 4, timestamp: daysAgo(2), category: "review"
    },
    {
      id: "CP005", author: "Naomi W.", authorInitial: "N",
      text: "Malindi banda via Sokoni BnBs was EVERYTHING. Woke up to the ocean every morning 🌊 Highly recommend Esther's place!",
      likes: 34, comments: 9, timestamp: daysAgo(3), category: "review"
    },
    {
      id: "CP006", author: "Kevin O.", authorInitial: "K",
      text: "Kaspa Prints did 200 branded tees for our startup launch. Quality was insane, delivered on time. These guys are the real deal 🎨",
      likes: 11, comments: 2, timestamp: daysAgo(1), category: "review"
    },
    {
      id: "CP007", author: "Lilian N.", authorInitial: "L",
      text: "Mama Clean Laundry on Sokoni Services is a lifesaver! Booked at 8am, rider picked up 10kg of clothes by 9:30am, everything back by 5pm — fresh, folded, sorted by person. KES 800 for the whole lot. 10/10 🧺✨",
      likes: 41, comments: 12, timestamp: daysAgo(0), category: "review"
    },
    {
      id: "CP008", author: "Dennis O.", authorInitial: "D",
      text: "Anyone else using CleanFold by Jane for shirt pressing? KES 50 per piece and she literally picks up from your door in Kasarani. My work shirts have never looked better 👔",
      likes: 23, comments: 8, timestamp: daysAgo(1), category: "review"
    },
    {
      id: "CP009", author: "Apex HR", authorInitial: "A",
      text: "We set up a weekly office laundry contract with FreshPress Laundromat through Sokoni — 25 staff uniforms collected and delivered every Monday. Takes one less thing off our plate 🙌 Highly recommend for SMEs.",
      likes: 17, comments: 5, timestamp: daysAgo(2), category: "tip"
    }
  ]));

  /* ═══════════════════════════════════════════════════════════
     15. PROMO CODES
  ═══════════════════════════════════════════════════════════ */
  localStorage.setItem("sokoniPromoCodes", JSON.stringify([
    { code: "WELCOME10",  discount: 10, uses: 0, maxUses: 500, expiresAt: daysAhead(30), createdAt: NOW },
    { code: "SOKONI20",   discount: 20, uses: 0, maxUses: 100, expiresAt: daysAhead(7),  createdAt: NOW },
    { code: "SOKONI10",   discount: 10, uses: 0, maxUses: 999, expiresAt: daysAhead(60), createdAt: NOW },
    { code: "NEWUSER15",  discount: 15, uses: 0, maxUses: 500, expiresAt: daysAhead(30), createdAt: NOW },
    { code: "LOYAL20",    discount: 20, uses: 0, maxUses: 200, expiresAt: daysAhead(14), createdAt: NOW },
    { code: "SAVE25",     discount: 25, uses: 0, maxUses:  50, expiresAt: daysAhead(7),  createdAt: NOW },
    { code: "CHEF15",     discount: 15, uses: 0, maxUses:  50, expiresAt: daysAhead(14), createdAt: NOW },
    { code: "NEWBNB",     discount: 12, uses: 0, maxUses: 200, expiresAt: daysAhead(21), createdAt: NOW },
    { code: "WASH20",     discount: 20, uses: 0, maxUses: 300, expiresAt: daysAhead(14), createdAt: NOW },
    { code: "MAMAFUA10",  discount: 10, uses: 0, maxUses: 500, expiresAt: daysAhead(30), createdAt: NOW }
  ]));

  /* ═══════════════════════════════════════════════════════════
     16. DEMO USER
  ═══════════════════════════════════════════════════════════ */
  if (!localStorage.getItem("sokoniUser")) {
    /* SHA-256 hash of "demo1234" — keeps the same format as registered users */
    var _demoHash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    localStorage.setItem("sokoniUser", JSON.stringify({
      name: "Demo User",
      email: "demo@sokoni.co.ke",
      passwordHash: _demoHash,
      roles: { buyer: true },
      joinedAt: new Date(daysAgo(30)).toLocaleDateString("en-KE",{day:"numeric",month:"short",year:"numeric"})
    }));
    localStorage.setItem("loggedIn", "true");
  }

  /* ═══════════════════════════════════════════════════════════
     17. BANKING HUB — Loan Applications & Community Posts
  ═══════════════════════════════════════════════════════════ */
  localStorage.setItem("sokoniBankApplications", JSON.stringify([
    {
      id: "BNK001", product: "Business Loan", bank: "KCB Bank",
      name: "Mercy Achieng", phone: "0711223344", email: "mercy@acme.co.ke",
      amount: 500000, purpose: "Stock / Inventory", business: "Mercy's General Store",
      notes: "Stocking up for December trading season", status: "approved",
      createdAt: daysAgo(5)
    },
    {
      id: "BNK002", product: "SACCO Membership", bank: "Stima SACCO",
      name: "John Otieno", phone: "0722334455", email: "",
      amount: 50000, purpose: "Working Capital", business: "",
      notes: "Want to start saving and access low-rate loans", status: "submitted",
      createdAt: daysAgo(2)
    },
    {
      id: "BNK003", product: "M-Pesa Paybill / Till Number", bank: "Safaricom",
      name: "Grace Wanjiku", phone: "0733445566", email: "",
      amount: 0, purpose: "Business Expansion", business: "Glam Studio by Winnie",
      notes: "Need paybill for my salon clients", status: "processing",
      createdAt: daysAgo(1)
    }
  ]));

  /* Banking community posts appended */
  const _bankPosts = JSON.parse(localStorage.getItem("sokoniCommunityPosts")||"[]");
  if(!_bankPosts.find(p=>p.id==="CP010")){
    _bankPosts.push(
      { id:"CP010", author:"Mercy A.", authorInitial:"M",
        text:"Just got approved for a KES 500,000 KCB Business Loan through Sokoni Banking Hub! Application was so easy — submitted all docs digitally, approved in 48hrs. If you need capital for your business, check the Banking Hub on Sokoni 🏦💰",
        likes:52, comments:14, timestamp:daysAgo(0), category:"review" },
      { id:"CP011", author:"Tom K.", authorInitial:"T",
        text:"Pro tip for Sokoni sellers: Set up a Paybill or Till Number NOW. It builds your M-Pesa transaction history which qualifies you for KCB M-Pesa & Equity loans with ZERO collateral after 6 months. Found all the info on Sokoni Banking Hub 📲",
        likes:38, comments:9, timestamp:daysAgo(1), category:"tip" },
      { id:"CP012", author:"James N.", authorInitial:"J",
        text:"Stima SACCO is paying 12.5% annual dividend this year. I've been a member 3 years and my savings have grown significantly while I also got a car loan at only 10% interest. Sokoni's Banking Hub explains how to join any SACCO 🤝",
        likes:29, comments:7, timestamp:daysAgo(2), category:"tip" }
    );
    localStorage.setItem("sokoniCommunityPosts", JSON.stringify(_bankPosts));
  }

  /* ── Mark seeded ── */
  /* ═══════════════════════════════════════════════════════════
     18. FOOD HUB — Restaurant Providers, Reviews, Stories,
         Community Posts & Ratings
  ═══════════════════════════════════════════════════════════ */

  /* Restaurant catering-style service providers */
  const _providers = JSON.parse(localStorage.getItem("sokoniServiceProviders")||"[]");
  const _restProviders = [
    {
      id:"SP019", name:"Java House", phone:"0800720725",
      category:"catering", skills:["Coffee","Brunch","Burgers","Café dining","Corporate catering"],
      location:"Nairobi", area:"All Nairobi branches",
      rate:500, rateType:"per person", bio:"Kenya's iconic café chain since 1999. Fresh coffee, all-day brunch, burgers & pastries. Corporate catering & private events available. Open 7 days.",
      rating:4.7, jobsCompleted:12400, available:true, verified:true, createdAt:daysAgo(365*5),
      isRestaurant:true, restaurantId:"REST001"
    },
    {
      id:"SP020", name:"Mama Mboga's Kitchen", phone:"0712111999",
      category:"catering", skills:["Ugali","Kenyan meals","Office lunch delivery","Budget catering","Vegetarian"],
      location:"Nairobi", area:"CBD & Westlands",
      rate:260, rateType:"per person", bio:"Authentic Kenyan home cooking delivered to your office or event. Order by 8am for same-day lunch delivery. Loved by 5,000+ repeat clients.",
      rating:4.8, jobsCompleted:8900, available:true, verified:true, createdAt:daysAgo(365*3),
      isRestaurant:true, restaurantId:"REST006"
    },
    {
      id:"SP021", name:"Pizza Inn Kenya", phone:"0800724411",
      category:"catering", skills:["Pizza","Italian","Party catering","Office events","Family meals"],
      location:"Nairobi", area:"Nairobi & Mombasa",
      rate:680, rateType:"per pizza", bio:"Kenya's favourite pizza chain. Thin crust, deep dish & stuffed crust. Caters for parties, corporate events & office Fridays. Min 5 pizzas for delivery.",
      rating:4.4, jobsCompleted:23000, available:true, verified:true, createdAt:daysAgo(365*8),
      isRestaurant:true, restaurantId:"REST003"
    },
    {
      id:"SP022", name:"Swahili Plate", phone:"0733100200",
      category:"catering", skills:["Biryani","Coastal cuisine","Halal","Seafood","Wedding catering"],
      location:"Mombasa", area:"Mombasa, Kilifi & Nairobi Westlands",
      rate:650, rateType:"per person", bio:"Authentic Swahili cuisine: biryani, pilau, seafood & coastal specialities. Fully Halal certified. Wedding, event & corporate catering specialists.",
      rating:4.8, jobsCompleted:1890, available:true, verified:true, createdAt:daysAgo(365*2),
      isRestaurant:true, restaurantId:"REST012"
    },
    {
      id:"SP023", name:"The Artisan Bakery", phone:"0700999888",
      category:"catering", skills:["Sourdough","Pastries","Wedding cakes","Corporate hampers","Coffee"],
      location:"Nairobi", area:"Kileleshwa, Karen & delivery",
      rate:200, rateType:"per item", bio:"Artisan bakery baking with love since 2021. Sourdough, croissants, cakes & pastries. Corporate hampers, wedding cakes & event catering on order.",
      rating:4.9, jobsCompleted:3400, available:true, verified:true, createdAt:daysAgo(365),
      isRestaurant:true, restaurantId:"REST009"
    }
  ];
  if(!_providers.find(p=>p.id==="SP019")){
    localStorage.setItem("sokoniServiceProviders", JSON.stringify([..._providers, ..._restProviders]));
  }

  /* Restaurant seller ratings */
  const _sRatings = JSON.parse(localStorage.getItem("sokoniSellerRatings")||"{}");
  if(!_sRatings["Java House"]){
    Object.assign(_sRatings, {
      "Java House":[
        { stars:5, avgScore:4.9, comment:"Best coffee in Nairobi! The Big Java Breakfast is unbeatable. Delivery was still hot.", buyerName:"Patricia N.", date:"28 May 2026", timestamp:daysAgo(0) },
        { stars:5, avgScore:4.8, comment:"Cold brew is PERFECT. Ordered 3 times this week already 😄", buyerName:"Adrian M.", date:"25 May 2026", timestamp:daysAgo(3) },
        { stars:4, avgScore:4.5, comment:"Java Burger is solid, chips are always crispy. Delivery on time.", buyerName:"Cynthia W.", date:"22 May 2026", timestamp:daysAgo(6) }
      ],
      "Mama Mboga's Kitchen":[
        { stars:5, avgScore:5.0, comment:"The ugali + tilapia combo is EVERYTHING. Feels like home. Ordered for the whole office.", buyerName:"Michael O.", date:"29 May 2026", timestamp:daysAgo(0) },
        { stars:5, avgScore:4.9, comment:"Best budget lunch in CBD. Githeri is delicious and delivery is super fast!", buyerName:"Grace K.", date:"27 May 2026", timestamp:daysAgo(1) }
      ],
      "Pizza Inn Kenya":[
        { stars:4, avgScore:4.4, comment:"BBQ chicken pizza is great value. Family of 4 fed for under 2k!", buyerName:"Denis W.", date:"26 May 2026", timestamp:daysAgo(2) },
        { stars:5, avgScore:4.7, comment:"Large Margarita for office pizza Friday — everyone loved it. Arrived hot.", buyerName:"Sandra N.", date:"23 May 2026", timestamp:daysAgo(5) }
      ],
      "Swahili Plate":[
        { stars:5, avgScore:5.0, comment:"Biryani is phenomenal! Reminded me of Mombasa Old Town. Best Swahili food on Sokoni.", buyerName:"Hassan A.", date:"28 May 2026", timestamp:daysAgo(0) },
        { stars:5, avgScore:4.9, comment:"Ordered prawn pilau for my parents' anniversary — they were BLOWN AWAY. Authentic coastal flavours!", buyerName:"Zainab M.", date:"24 May 2026", timestamp:daysAgo(4) }
      ],
      "The Artisan Bakery":[
        { stars:5, avgScore:5.0, comment:"Sourdough is the best I've had in Kenya. Ordered Friday, ate all weekend 🙌", buyerName:"Louise K.", date:"29 May 2026", timestamp:daysAgo(0) },
        { stars:5, avgScore:4.9, comment:"Pain au chocolat is buttery perfection. The cinnamon rolls — unreal! Will order every week.", buyerName:"Brian M.", date:"26 May 2026", timestamp:daysAgo(2) }
      ]
    });
    localStorage.setItem("sokoniSellerRatings", JSON.stringify(_sRatings));
  }

  /* Food platform reviews */
  const _revs = JSON.parse(localStorage.getItem("sokoniReviews")||"[]");
  if(!_revs.find(r=>r.id==="r11")){
    _revs.push(
      { id:"r11", type:"platform", name:"Adrian Mwangi", rating:5, comment:"Ordered Java House cold brew and a burger for lunch via Sokoni Food Hub — arrived in 32 minutes, still cold, still hot. Game changer for office workers in Nairobi!", date:"28 May 2026", timestamp:daysAgo(0) },
      { id:"r12", type:"platform", name:"Patricia Njeri", rating:5, comment:"Finally! A marketplace where I can order Mama Mboga's ugali AND my Java flat white on the same platform. Sokoni Food Hub is brilliant.", date:"27 May 2026", timestamp:daysAgo(1) },
      { id:"r13", type:"platform", name:"Hassan Abdallah", rating:5, comment:"Swahili Plate biryani delivered to my Nairobi office from Westlands. Authentic coastal flavours — honestly better than flying to Mombasa 😂 Sokoni Food Hub is THAT good!", date:"26 May 2026", timestamp:daysAgo(2) }
    );
    localStorage.setItem("sokoniReviews", JSON.stringify(_revs));
  }

  /* Food stories */
  const _stories = JSON.parse(localStorage.getItem("sokoniStories")||"[]");
  if(!_stories.find(s=>s.id==="STR010")){
    _stories.push(
      { id:"STR010", sellerName:"Java House", sellerEmail:"java@sokoni.ke", type:"photo",
        media:"https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=400&q=75",
        caption:"☕ Morning sorted! Order your Flat White + Big Java Breakfast on Sokoni Food Hub. Delivered hot in 30 min ✨",
        ctaLink:"food.html?cuisine=coffee",
        createdAt:NOW - 0.5*HR, expiresAt:NOW + 23.5*HR, views:312, viewedBy:[] },
      { id:"STR011", sellerName:"Mama Mboga's Kitchen", sellerEmail:"mamamboga@sokoni.ke", type:"photo",
        media:"https://images.unsplash.com/photo-1596040033229-a9821ebd058d?w=400&q=75",
        caption:"🍲 Lunch is ready! Ugali + tilapia, ugali + beef stew, chapati + lentils. Order by 11am for 12pm delivery 📦",
        ctaLink:"food.html?cuisine=kenyan",
        createdAt:NOW - 2*HR, expiresAt:NOW + 22*HR, views:198, viewedBy:[] },
      { id:"STR012", sellerName:"The Artisan Bakery", sellerEmail:"artisan@sokoni.ke", type:"photo",
        media:"https://images.unsplash.com/photo-1509440159596-0249088772ff?w=400&q=75",
        caption:"🥐 Fresh from the oven! Croissants, cinnamon rolls, sourdough loaves ready now. Order on Sokoni Food Hub 🔥",
        ctaLink:"food.html?cuisine=bakery",
        createdAt:NOW - 1*HR, expiresAt:NOW + 23*HR, views:144, viewedBy:[] }
    );
    localStorage.setItem("sokoniStories", JSON.stringify(_stories));
  }

  /* Food community posts */
  const _cposts = JSON.parse(localStorage.getItem("sokoniCommunityPosts")||"[]");
  if(!_cposts.find(p=>p.id==="CP013")){
    _cposts.push(
      { id:"CP013", author:"Adrian M.", authorInitial:"A",
        text:"SOKONI FOOD HUB IS HERE! Just ordered Java House cold brew + Big Java Breakfast, Mama Mboga's ugali for the whole team, AND a sourdough from The Artisan Bakery — all on one platform. This is what Kenya needed! 🍽️☕🍲",
        likes:89, comments:22, timestamp:daysAgo(0), category:"review" },
      { id:"CP014", author:"Zainab M.", authorInitial:"Z",
        text:"Swahili Plate biryani delivered to Westlands Nairobi with the real Mombasa coastal flavours 🌊🍛 The prawn pilau + coconut rice is INCREDIBLE. Order on Sokoni Food Hub. Fully Halal certified too! ✅",
        likes:64, comments:18, timestamp:daysAgo(0), category:"review" },
      { id:"CP015", author:"Michael O.", authorInitial:"M",
        text:"Office lunch tip: Set up a group order for your team on Sokoni Food Hub. We got 8 different meals from Mama Mboga's Kitchen — ugali stew, tilapia, chapati — all under KES 2,500 for the whole team! Unbeatable value 🙌",
        likes:47, comments:13, timestamp:daysAgo(1), category:"tip" },
      { id:"CP016", author:"Louise K.", authorInitial:"L",
        text:"The Artisan Bakery's sourdough loaf on Sokoni Food Hub is hands down the best bread in Nairobi. 72-hour ferment, crispy crust, perfect crumb. Delivered fresh every Friday morning 🥖",
        likes:38, comments:9, timestamp:daysAgo(2), category:"review" }
    );
    localStorage.setItem("sokoniCommunityPosts", JSON.stringify(_cposts));
  }

  /* Food Hub messages */
  const _msgs = JSON.parse(localStorage.getItem("sokoniMessages")||"[]");
  if(!_msgs.find(m=>m.id==="conv_food_java")){
    _msgs.unshift(
      { id:"conv_food_java", productName:"Big Java Breakfast + Flat White",
        sellerName:"Java House",
        messages:[
          { sender:"seller", text:"Hi there! ☕ Welcome to Java House on Sokoni!\n\nYour order is confirmed:\n• 1× Flat White — KES 380\n• 1× Big Java Breakfast — KES 950\n\nEstimated delivery: 28 minutes\nDelivery tracking: 🛵 Rider on the way!\n\nEnjoy your breakfast! 🍳", time:"08:30" },
          { sender:"buyer", text:"Thank you! Will the coffee still be hot on arrival?", time:"08:32" },
          { sender:"seller", text:"Absolutely! We use insulated packaging for all hot beverages. Your flat white will arrive at 65°C+ — perfect temperature. Delivery ETA 08:58. Track on the Sokoni app! ☕", time:"08:33" }
        ],
        unread:1, spam:false, createdAt:daysAgo(0) },
      { id:"conv_food_pizza", productName:"BBQ Chicken Pizza (Large)",
        sellerName:"Pizza Inn Kenya",
        messages:[
          { sender:"buyer", text:"Can I order 2 large pizzas for office of 8 people?", time:"11:45" },
          { sender:"seller", text:"Absolutely! 2 large pizzas easily feeds 8 people (3-4 slices each). We recommend: 1× Large BBQ Chicken (KES 980) + 1× Large Pepperoni (KES 1,380) + Large Garlic Bread (KES 280) = KES 2,640 total. Free delivery on orders over KES 2,000! 🍕 Shall I confirm?", time:"11:47" }
        ],
        unread:1, spam:false, createdAt:daysAgo(0) }
    );
    localStorage.setItem("sokoniMessages", JSON.stringify(_msgs));
  }

  /* ═══════════════════════════════════════════════════════════
     19. ADULT CATEGORIES — Alcohol, Vape, Tobacco, Adult Products
         All 18+ gated. Rich product listings.
  ═══════════════════════════════════════════════════════════ */
  const _existing = JSON.parse(localStorage.getItem("sellerProducts")||"[]");
  if(!_existing.find(p=>p.category==="alcohol")){
    const ADULT_PRODUCTS = [

      /* ── ALCOHOL ── */
      { id:uid("ALC"), name:"Johnnie Walker Black Label (700ml)", price:4800, costPrice:3800, deliveryCost:150, stock:30, sold:67,
        category:"alcohol", location:"nairobi", isAdult:true,
        description:"Aged 12 years. Rich, complex Scotch whisky. Smooth finish. Original sealed bottle.",
        image:"https://images.unsplash.com/photo-1527281400683-1aae777175f8?w=400&q=75",
        sellerName:"Spirits & More KE", sellerEmail:"spirits@sokoni.ke",
        uploadedAt:daysAgo(2), views:312, outOfStock:false, wishlistCount:44, kebsCert:"" },
      { id:uid("ALC"), name:"Tusker Lager 6-Pack (500ml each)", price:960, costPrice:720, deliveryCost:100, stock:200, sold:412,
        category:"alcohol", location:"nairobi", isAdult:true,
        description:"Kenya's iconic lager. Cold chain delivered. Crisp and refreshing. 6×500ml.",
        image:"https://images.unsplash.com/photo-1535958636474-b021ee887b13?w=400&q=75",
        sellerName:"Spirits & More KE", sellerEmail:"spirits@sokoni.ke",
        uploadedAt:daysAgo(0), views:489, outOfStock:false, wishlistCount:78, kebsCert:"" },
      { id:uid("ALC"), name:"Jameson Irish Whiskey (700ml)", price:3200, costPrice:2600, deliveryCost:150, stock:25, sold:89,
        category:"alcohol", location:"nairobi", isAdult:true,
        description:"Triple distilled. Perfectly balanced. The world's best selling Irish whiskey. Sealed.",
        image:"https://images.unsplash.com/photo-1569529465841-dfecdab7503b?w=400&q=75",
        sellerName:"Spirits & More KE", sellerEmail:"spirits@sokoni.ke",
        uploadedAt:daysAgo(1), views:218, outOfStock:false, wishlistCount:31, kebsCert:"" },
      { id:uid("ALC"), name:"Hennessy VS Cognac (700ml)", price:12000, costPrice:9500, deliveryCost:200, stock:10, sold:23,
        category:"alcohol", location:"nairobi", isAdult:true,
        description:"The world's #1 cognac. Smooth, rich and aromatic. Sealed original bottle.",
        image:"https://images.unsplash.com/photo-1553361371-9b22f78e8b1d?w=400&q=75",
        sellerName:"Spirits & More KE", sellerEmail:"spirits@sokoni.ke",
        uploadedAt:daysAgo(3), views:156, outOfStock:false, wishlistCount:19, kebsCert:"" },
      { id:uid("ALC"), name:"Kenya Cane (750ml)", price:650, costPrice:480, deliveryCost:100, stock:100, sold:234,
        category:"alcohol", location:"nairobi", isAdult:true,
        description:"Kenya's top selling cane spirit. Classic Kenyan drink. Great with soda.",
        image:"https://images.unsplash.com/photo-1514362453360-8f94243c9996?w=400&q=75",
        sellerName:"Spirits & More KE", sellerEmail:"spirits@sokoni.ke",
        uploadedAt:daysAgo(0), views:678, outOfStock:false, wishlistCount:92, kebsCert:"" },
      { id:uid("ALC"), name:"Amarula Cream Liqueur (750ml)", price:2500, costPrice:1900, deliveryCost:150, stock:20, sold:45,
        category:"alcohol", location:"nairobi", isAdult:true,
        description:"South Africa's exotic cream liqueur. Marula fruit + cream. Perfect on ice.",
        image:"https://images.unsplash.com/photo-1527281400683-1aae777175f8?w=400&q=75",
        sellerName:"Spirits & More KE", sellerEmail:"spirits@sokoni.ke",
        uploadedAt:daysAgo(2), views:134, outOfStock:false, wishlistCount:22, kebsCert:"" },
      { id:uid("ALC"), name:"Jack Daniel's Old No. 7 (700ml)", price:4500, costPrice:3600, deliveryCost:150, stock:18, sold:56,
        category:"alcohol", location:"nairobi", isAdult:true,
        description:"Original Tennessee Whiskey. Charcoal mellowed. Smooth and iconic. Sealed.",
        image:"https://images.unsplash.com/photo-1569529465841-dfecdab7503b?w=400&q=75",
        sellerName:"Spirits & More KE", sellerEmail:"spirits@sokoni.ke",
        uploadedAt:daysAgo(1), views:201, outOfStock:false, wishlistCount:38, kebsCert:"" },
      { id:uid("ALC"), name:"Captain Morgan Spiced Gold (700ml)", price:1800, costPrice:1400, deliveryCost:100, stock:40, sold:112,
        category:"alcohol", location:"nairobi", isAdult:true,
        description:"Caribbean rum with signature spices and natural flavours. Great cocktail base.",
        image:"https://images.unsplash.com/photo-1514362453360-8f94243c9996?w=400&q=75",
        sellerName:"Spirits & More KE", sellerEmail:"spirits@sokoni.ke",
        uploadedAt:daysAgo(0), views:345, outOfStock:false, wishlistCount:56, kebsCert:"" },
      { id:uid("ALC"), name:"Gilbey's London Dry Gin (750ml)", price:1100, costPrice:800, deliveryCost:100, stock:60, sold:178,
        category:"alcohol", location:"nairobi", isAdult:true,
        description:"Classic dry gin. Crisp, clean juniper flavour. Perfect G&T. Widely available.",
        image:"https://images.unsplash.com/photo-1527281400683-1aae777175f8?w=400&q=75",
        sellerName:"Spirits & More KE", sellerEmail:"spirits@sokoni.ke",
        uploadedAt:daysAgo(0), views:267, outOfStock:false, wishlistCount:43, kebsCert:"" },
      { id:uid("ALC"), name:"Konyagi (750ml) — Tanzania Spirit", price:550, costPrice:400, deliveryCost:100, stock:150, sold:312,
        category:"alcohol", location:"nairobi", isAdult:true,
        description:"East Africa's favourite spirit. Light, clean taste. Affordable party essential.",
        image:"https://images.unsplash.com/photo-1553361371-9b22f78e8b1d?w=400&q=75",
        sellerName:"Spirits & More KE", sellerEmail:"spirits@sokoni.ke",
        uploadedAt:daysAgo(1), views:456, outOfStock:false, wishlistCount:67, kebsCert:"" },
      { id:uid("ALC"), name:"Martell Cognac VSOP (700ml)", price:8500, costPrice:7000, deliveryCost:200, stock:8, sold:14,
        category:"alcohol", location:"nairobi", isAdult:true,
        description:"Exceptional cognac from the Charente. Aged in French oak. Silky and refined.",
        image:"https://images.unsplash.com/photo-1553361371-9b22f78e8b1d?w=400&q=75",
        sellerName:"Spirits & More KE", sellerEmail:"spirits@sokoni.ke",
        uploadedAt:daysAgo(4), views:89, outOfStock:false, wishlistCount:12, kebsCert:"" },
      { id:uid("ALC"), name:"White Cap Lager 6-Pack (500ml)", price:840, costPrice:640, deliveryCost:100, stock:200, sold:534,
        category:"alcohol", location:"nairobi", isAdult:true,
        description:"Kenya's beloved pilsner lager. Crisp, clean and refreshing. 6 pack.",
        image:"https://images.unsplash.com/photo-1535958636474-b021ee887b13?w=400&q=75",
        sellerName:"Spirits & More KE", sellerEmail:"spirits@sokoni.ke",
        uploadedAt:daysAgo(0), views:612, outOfStock:false, wishlistCount:88, kebsCert:"" },

      /* ── VAPE ── */
      { id:uid("VP"), name:"Elf Bar BC5000 Disposable Vape", price:2800, costPrice:1800, deliveryCost:150, stock:50, sold:134,
        category:"vape", location:"nairobi", isAdult:true,
        description:"5000 puffs. 13ml e-liquid. Rechargeable USB-C. Available in 15+ flavours: Watermelon, Mango Ice, Blue Razz, Peach, Mint.",
        image:"https://images.unsplash.com/photo-1567532939604-b6b5b0db2604?w=400&q=75",
        sellerName:"Vape Zone KE", sellerEmail:"vapezone@sokoni.ke",
        uploadedAt:daysAgo(1), views:287, outOfStock:false, wishlistCount:45, kebsCert:"" },
      { id:uid("VP"), name:"Vaporesso XROS Mini Pod Kit", price:3800, costPrice:2800, deliveryCost:150, stock:20, sold:56,
        category:"vape", location:"nairobi", isAdult:true,
        description:"1000mAh battery. 2ml pod. Adjustable airflow. Compact and elegant MTL device. USB-C charging.",
        image:"https://images.unsplash.com/photo-1567532939604-b6b5b0db2604?w=400&q=75",
        sellerName:"Vape Zone KE", sellerEmail:"vapezone@sokoni.ke",
        uploadedAt:daysAgo(2), views:178, outOfStock:false, wishlistCount:28, kebsCert:"" },
      { id:uid("VP"), name:"Lost Mary BM5000 — Blueberry Ice", price:2500, costPrice:1600, deliveryCost:150, stock:60, sold:189,
        category:"vape", location:"nairobi", isAdult:true,
        description:"5000 smooth puffs. Icy blueberry burst. Disposable — no coil changes or filling needed.",
        image:"https://images.unsplash.com/photo-1567532939604-b6b5b0db2604?w=400&q=75",
        sellerName:"Vape Zone KE", sellerEmail:"vapezone@sokoni.ke",
        uploadedAt:daysAgo(0), views:345, outOfStock:false, wishlistCount:67, kebsCert:"" },
      { id:uid("VP"), name:"Smok Nord Pro 4 Pod Kit", price:4500, costPrice:3400, deliveryCost:150, stock:15, sold:34,
        category:"vape", location:"nairobi", isAdult:true,
        description:"2000mAh battery. 4.5ml pod capacity. RPM 2 and Nord coil compatible. Adjustable wattage 5–45W.",
        image:"https://images.unsplash.com/photo-1567532939604-b6b5b0db2604?w=400&q=75",
        sellerName:"Vape Zone KE", sellerEmail:"vapezone@sokoni.ke",
        uploadedAt:daysAgo(3), views:123, outOfStock:false, wishlistCount:18, kebsCert:"" },
      { id:uid("VP"), name:"Yuoto Thanos 5000 Puffs (Various Flavours)", price:2200, costPrice:1400, deliveryCost:150, stock:80, sold:212,
        category:"vape", location:"nairobi", isAdult:true,
        description:"5000 puffs. 12ml pre-filled. USB-C rechargeable. Choose from: Strawberry, Grape Ice, Lychee, Peach Mango.",
        image:"https://images.unsplash.com/photo-1567532939604-b6b5b0db2604?w=400&q=75",
        sellerName:"Vape Zone KE", sellerEmail:"vapezone@sokoni.ke",
        uploadedAt:daysAgo(1), views:298, outOfStock:false, wishlistCount:54, kebsCert:"" },
      { id:uid("VP"), name:"Premium E-Liquid 60ml (Nicotine-Free)", price:1200, costPrice:700, deliveryCost:100, stock:100, sold:89,
        category:"vape", location:"nairobi", isAdult:true,
        description:"60ml shortfill. 70VG/30PG. Available: Strawberry Custard, Tropical Fruit, Cool Mint, Vanilla Bean.",
        image:"https://images.unsplash.com/photo-1567532939604-b6b5b0db2604?w=400&q=75",
        sellerName:"Vape Zone KE", sellerEmail:"vapezone@sokoni.ke",
        uploadedAt:daysAgo(0), views:156, outOfStock:false, wishlistCount:23, kebsCert:"" },

      /* ── TOBACCO ── */
      { id:uid("TC"), name:"Marlboro Red (Pack of 20)", price:500, costPrice:380, deliveryCost:0, stock:500, sold:2345,
        category:"tobacco", location:"nairobi", isAdult:true,
        description:"Iconic full-flavour cigarettes. 20 cigarettes per pack. Genuine Marlboro Kenya.",
        image:"https://images.unsplash.com/photo-1527670776-bdf29b30b23e?w=400&q=75",
        sellerName:"Tobacco Plus KE", sellerEmail:"tobacco@sokoni.ke",
        uploadedAt:daysAgo(0), views:1234, outOfStock:false, wishlistCount:123, kebsCert:"" },
      { id:uid("TC"), name:"Dunhill Fine Cut King Size (Pack of 20)", price:520, costPrice:400, deliveryCost:0, stock:300, sold:1123,
        category:"tobacco", location:"nairobi", isAdult:true,
        description:"Premium cut tobacco with smooth, refined taste. 20 per pack.",
        image:"https://images.unsplash.com/photo-1527670776-bdf29b30b23e?w=400&q=75",
        sellerName:"Tobacco Plus KE", sellerEmail:"tobacco@sokoni.ke",
        uploadedAt:daysAgo(1), views:678, outOfStock:false, wishlistCount:67, kebsCert:"" },
      { id:uid("TC"), name:"Camel Blue (Pack of 20)", price:480, costPrice:360, deliveryCost:0, stock:400, sold:987,
        category:"tobacco", location:"nairobi", isAdult:true,
        description:"Smooth and balanced. Lower tar alternative. 20 per pack. Original Camel.",
        image:"https://images.unsplash.com/photo-1527670776-bdf29b30b23e?w=400&q=75",
        sellerName:"Tobacco Plus KE", sellerEmail:"tobacco@sokoni.ke",
        uploadedAt:daysAgo(0), views:456, outOfStock:false, wishlistCount:45, kebsCert:"" },
      { id:uid("TC"), name:"Premium Shisha Tobacco — Al Fakher (100g)", price:1200, costPrice:900, deliveryCost:100, stock:60, sold:234,
        category:"tobacco", location:"nairobi", isAdult:true,
        description:"Double apple, mint, watermelon, grape, peach. Premium molasses shisha tobacco. 100g tin.",
        image:"https://images.unsplash.com/photo-1527670776-bdf29b30b23e?w=400&q=75",
        sellerName:"Tobacco Plus KE", sellerEmail:"tobacco@sokoni.ke",
        uploadedAt:daysAgo(2), views:312, outOfStock:false, wishlistCount:56, kebsCert:"" },
      { id:uid("TC"), name:"Embassy Filter King Size (Pack of 20)", price:350, costPrice:260, deliveryCost:0, stock:600, sold:3456,
        category:"tobacco", location:"nairobi", isAdult:true,
        description:"Kenya's most popular cigarette. Affordable, consistent, reliable flavour.",
        image:"https://images.unsplash.com/photo-1527670776-bdf29b30b23e?w=400&q=75",
        sellerName:"Tobacco Plus KE", sellerEmail:"tobacco@sokoni.ke",
        uploadedAt:daysAgo(0), views:2345, outOfStock:false, wishlistCount:234, kebsCert:"" },
      { id:uid("TC"), name:"Premium Hookah / Shisha Charcoal (1kg)", price:800, costPrice:550, deliveryCost:100, stock:80, sold:167,
        category:"tobacco", location:"nairobi", isAdult:true,
        description:"Odourless coconut shell charcoal. Burns clean and long. 1kg box. For home or lounge use.",
        image:"https://images.unsplash.com/photo-1527670776-bdf29b30b23e?w=400&q=75",
        sellerName:"Tobacco Plus KE", sellerEmail:"tobacco@sokoni.ke",
        uploadedAt:daysAgo(1), views:189, outOfStock:false, wishlistCount:34, kebsCert:"" },

      /* ── ADULT PRODUCTS ── */
      { id:uid("AD"), name:"Premium Vibrating Wand Massager", price:3500, costPrice:2200, deliveryCost:100, stock:30, sold:89,
        category:"adult", location:"nairobi", isAdult:true,
        description:"Personal massager wand. 10 vibration modes. USB-C rechargeable. Whisper quiet. Discreet plain packaging. Waterproof.",
        image:"https://images.unsplash.com/photo-1571781926291-c477ebfd024b?w=400&q=75",
        sellerName:"Intimacy KE", sellerEmail:"intimacy@sokoni.ke",
        uploadedAt:daysAgo(2), views:234, outOfStock:false, wishlistCount:45, isDiscreet:true, kebsCert:"" },
      { id:uid("AD"), name:"Couples Intimacy Kit — 6 Piece Set", price:5500, costPrice:3500, deliveryCost:100, stock:20, sold:56,
        category:"adult", location:"nairobi", isAdult:true,
        description:"Premium couples gift set. 6 intimate accessories. Body-safe silicone. Discreet branded packaging. USB rechargeable.",
        image:"https://images.unsplash.com/photo-1571781926291-c477ebfd024b?w=400&q=75",
        sellerName:"Intimacy KE", sellerEmail:"intimacy@sokoni.ke",
        uploadedAt:daysAgo(1), views:156, outOfStock:false, wishlistCount:34, isDiscreet:true, kebsCert:"" },
      { id:uid("AD"), name:"Luxury Soy Massage Candles Set (3 scents)", price:2200, costPrice:1400, deliveryCost:100, stock:50, sold:112,
        category:"adult", location:"nairobi", isAdult:true,
        description:"Rose, Vanilla, and Jasmine. Low-melt soy wax candles that turn into warm massage oil. Skin-safe, paraben-free.",
        image:"https://images.unsplash.com/photo-1543794646-6f41e7a3a2a5?w=400&q=75",
        sellerName:"Intimacy KE", sellerEmail:"intimacy@sokoni.ke",
        uploadedAt:daysAgo(0), views:289, outOfStock:false, wishlistCount:67, isDiscreet:true, kebsCert:"" },
      { id:uid("AD"), name:"Premium Silicone Body Oil (Rose + Jojoba)", price:1800, costPrice:1100, deliveryCost:100, stock:60, sold:145,
        category:"adult", location:"nairobi", isAdult:true,
        description:"Deeply hydrating rose & jojoba body oil. Natural ingredients. Warming sensation. 200ml glass bottle. Paraben-free.",
        image:"https://images.unsplash.com/photo-1571781926291-c477ebfd024b?w=400&q=75",
        sellerName:"Intimacy KE", sellerEmail:"intimacy@sokoni.ke",
        uploadedAt:daysAgo(0), views:198, outOfStock:false, wishlistCount:43, isDiscreet:true, kebsCert:"" },
      { id:uid("AD"), name:"Elegant Lingerie Set — Sizes S–XL", price:2500, costPrice:1500, deliveryCost:100, stock:40, sold:78,
        category:"adult", location:"nairobi", isAdult:true,
        description:"Premium lace lingerie set. Bra + underwear + garter. Available in black, red, nude. Sizes S/M/L/XL. Discreet packaging.",
        image:"https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=400&q=75",
        sellerName:"Intimacy KE", sellerEmail:"intimacy@sokoni.ke",
        uploadedAt:daysAgo(1), views:312, outOfStock:false, wishlistCount:78, isDiscreet:true, kebsCert:"" },
      { id:uid("AD"), name:"Couples Board Game — Naughty Edition", price:3200, costPrice:2000, deliveryCost:150, stock:25, sold:45,
        category:"adult", location:"nairobi", isAdult:true,
        description:"Fun, adult board game for couples. 150 challenge cards, dice, timer. Spice up date night. Discreet packaging.",
        image:"https://images.unsplash.com/photo-1543794646-6f41e7a3a2a5?w=400&q=75",
        sellerName:"Intimacy KE", sellerEmail:"intimacy@sokoni.ke",
        uploadedAt:daysAgo(3), views:167, outOfStock:false, wishlistCount:34, isDiscreet:true, kebsCert:"" },
      { id:uid("AD"), name:"Premium Personal Lubricant (Water-Based, 150ml)", price:1200, costPrice:700, deliveryCost:100, stock:100, sold:234,
        category:"adult", location:"nairobi", isAdult:true,
        description:"Body-safe, water-based formula. pH balanced. Fragrance-free. Long-lasting. Dermatologist tested. 150ml pump bottle.",
        image:"https://images.unsplash.com/photo-1571781926291-c477ebfd024b?w=400&q=75",
        sellerName:"Intimacy KE", sellerEmail:"intimacy@sokoni.ke",
        uploadedAt:daysAgo(0), views:345, outOfStock:false, wishlistCount:56, isDiscreet:true, kebsCert:"" }
    ];
    const _allWithAdult = [..._existing, ...ADULT_PRODUCTS];
    localStorage.setItem("sellerProducts", JSON.stringify(_allWithAdult));
  }

  /* ═══════════════════════════════════════════════════════════
     20. FOOTBALL FIXTURES  — 20 Kenyan matches (live/upcoming/done)
  ═══════════════════════════════════════════════════════════ */
  const _d1 = new Date(NOW + 1*DAY).toISOString().slice(0,10);
  const _d2 = new Date(NOW + 2*DAY).toISOString().slice(0,10);
  const _d3 = new Date(NOW + 3*DAY).toISOString().slice(0,10);
  const _d4 = new Date(NOW + 5*DAY).toISOString().slice(0,10);
  const _d5 = new Date(NOW + 7*DAY).toISOString().slice(0,10);
  const _today = new Date(NOW).toISOString().slice(0,10);
  const _yd = new Date(NOW - 1*DAY).toISOString().slice(0,10);
  const _2d = new Date(NOW - 2*DAY).toISOString().slice(0,10);
  const _3d = new Date(NOW - 3*DAY).toISOString().slice(0,10);

  localStorage.setItem("sokoniFixtures", JSON.stringify([
    /* ── LIVE NOW ── */
    {id:'FX101',home:'Gor Mahia FC',homeIcon:'🦁',away:'AFC Leopards',awayIcon:'🐆',
     date:_today,time:'15:00',venue:'Nyayo National Stadium',sport:'football',
     format:'Full Match',tournament:'KPL Nairobi Derby',status:'live',score:'1-0',
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX102',home:'Westgate Lions FC',homeIcon:'👑',away:'Kasarani Kings',awayIcon:'🏅',
     date:_today,time:'16:30',venue:'Westlands FC Turf',sport:'football',
     format:'5-a-Side',tournament:'Nairobi Premier League',status:'live',score:'2-1',
     postedBy:'admin',postedByName:'SOKONI Sports'},

    /* ── TODAY UPCOMING ── */
    {id:'FX103',home:'Embakasi Warriors',homeIcon:'🛡️',away:'South B Sharks',awayIcon:'🦈',
     date:_today,time:'18:00',venue:'Embakasi Grounds',sport:'football',
     format:'7-a-Side',tournament:'Nairobi Premier League',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX104',home:'Karen FC',homeIcon:'🌿',away:'Lang\'ata Rangers',awayIcon:'🏆',
     date:_today,time:'19:00',venue:'Karen Sports Club',sport:'football',
     format:'5-a-Side',tournament:'Nairobi Weekend League',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX105',home:'Eastleigh Stars',homeIcon:'⭐',away:'Pangani United',awayIcon:'🔵',
     date:_today,time:'20:00',venue:'Eastleigh FC Ground',sport:'football',
     format:'7-a-Side',tournament:'',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},

    /* ── TOMORROW ── */
    {id:'FX106',home:'Tusker FC',homeIcon:'🐘',away:'Bandari FC',awayIcon:'⚓',
     date:_d1,time:'15:00',venue:'Ruaraka FC Turf',sport:'football',
     format:'Full Match',tournament:'KPL Matchday 18',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX107',home:'Mathare United',homeIcon:'🔴',away:'Posta Rangers',awayIcon:'📬',
     date:_d1,time:'17:00',venue:'Mathare Youth Ground',sport:'football',
     format:'Full Match',tournament:'KPL Matchday 18',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX108',home:'Ruiru Rockets',homeIcon:'🚀',away:'Thika Thunder',awayIcon:'⚡',
     date:_d1,time:'18:30',venue:'Kasarani Sports Park',sport:'football',
     format:'7-a-Side',tournament:'',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX109',home:'Kitengela United',homeIcon:'🦏',away:'Athi River FC',awayIcon:'💧',
     date:_d1,time:'16:00',venue:'Kitengela Sports Complex',sport:'football',
     format:'5-a-Side',tournament:'Nairobi Premier League',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},

    /* ── IN 2 DAYS ── */
    {id:'FX110',home:'Mombasa City Stars',homeIcon:'🌊',away:'Coastal Raiders FC',awayIcon:'⚔️',
     date:_d2,time:'15:00',venue:'Mombasa Sports Club',sport:'football',
     format:'Full Match',tournament:'Coastal Premier Cup',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX111',home:'Kisumu All Stars',homeIcon:'🐟',away:'Nakuru United',awayIcon:'🦒',
     date:_d2,time:'17:00',venue:'Kisumu Municipal Stadium',sport:'football',
     format:'Full Match',tournament:'Western Kenya Cup',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX112',home:'NBA Kenya A',homeIcon:'🏀',away:'NBA Kenya B',awayIcon:'🏀',
     date:_d2,time:'14:00',venue:'Kasarani Sports Park',sport:'basketball',
     format:'3x3',tournament:'NBA Kenya 3x3 Nairobi',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},

    /* ── NEXT WEEK ── */
    {id:'FX113',home:'Gor Mahia FC',homeIcon:'🦁',away:'Tusker FC',awayIcon:'🐘',
     date:_d3,time:'16:00',venue:'Nyayo National Stadium',sport:'football',
     format:'Full Match',tournament:'KPL Matchday 19',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX114',home:'AFC Leopards',homeIcon:'🐆',away:'Bandari FC',awayIcon:'⚓',
     date:_d4,time:'15:00',venue:'Nyayo National Stadium',sport:'football',
     format:'Full Match',tournament:'KPL Matchday 19',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX115',home:'Kenya U-23',homeIcon:'🇰🇪',away:'Tanzania U-23',awayIcon:'🇹🇿',
     date:_d5,time:'16:00',venue:'Nyayo National Stadium',sport:'football',
     format:'Full Match',tournament:'CECAFA U-23 Cup',status:'upcoming',score:null,
     postedBy:'admin',postedByName:'SOKONI Sports'},

    /* ── COMPLETED RESULTS ── */
    {id:'FX116',home:'Kasarani Kings',homeIcon:'🏅',away:'Langata Eagles',awayIcon:'🦅',
     date:_yd,time:'17:00',venue:'Kasarani Sports Park',sport:'football',
     format:'7-a-Side',tournament:'',status:'done',score:'3-0',
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX117',home:'Gor Mahia FC',homeIcon:'🦁',away:'Mathare United',awayIcon:'🔴',
     date:_yd,time:'15:00',venue:'Nyayo National Stadium',sport:'football',
     format:'Full Match',tournament:'KPL Matchday 17',status:'done',score:'2-1',
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX118',home:'Ruiru Rockets',homeIcon:'🚀',away:'Nairobi United FC',awayIcon:'🏙️',
     date:_2d,time:'18:00',venue:'Ruiru United Ground',sport:'football',
     format:'7-a-Side',tournament:'',status:'done',score:'1-2',
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX119',home:'Westgate Lions FC',homeIcon:'👑',away:'Embakasi Warriors',awayIcon:'🛡️',
     date:_2d,time:'16:00',venue:'Westlands FC Turf',sport:'football',
     format:'5-a-Side',tournament:'Nairobi Premier League',status:'done',score:'4-2',
     postedBy:'admin',postedByName:'SOKONI Sports'},
    {id:'FX120',home:'Tusker FC',homeIcon:'🐘',away:'Posta Rangers',awayIcon:'📬',
     date:_3d,time:'15:00',venue:'Ruaraka FC Turf',sport:'football',
     format:'Full Match',tournament:'KPL Matchday 16',status:'done',score:'1-0',
     postedBy:'admin',postedByName:'SOKONI Sports'}
  ]));

  /* ═══════════════════════════════════════════════════════════
     21. DEMO SHOPS  — 3 complete mini-store profiles
  ═══════════════════════════════════════════════════════════ */
  if (!localStorage.getItem("sokoniShopProfiles")) {
    localStorage.setItem("sokoniShopProfiles", JSON.stringify([
      {
        id: "SHOP001", name: "Sokoni Electronics", email: "electronics@sokoni.ke",
        phone: "0712345001", location: "Westlands, Nairobi",
        logo: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=200&q=80",
        banner: "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=800&q=75",
        bio: "Kenya's premium electronics store. Samsung, Sony, Xiaomi, Apple & more. 1-year warranty on all items. Same-day delivery Nairobi wide.",
        categories: ["electronics", "computers", "gaming"],
        rating: 4.8, reviews: 127, followers: 342, verified: true,
        joinedAt: "Jan 2026", orders: 312, responseTime: "Under 5 min",
        badge: "Top Seller", badgeColor: "#71ff00"
      },
      {
        id: "SHOP002", name: "Green Farm Kenya", email: "greenfarm@sokoni.ke",
        phone: "0722345002", location: "Limuru Road, Nairobi",
        logo: "https://images.unsplash.com/photo-1550583724-b2692b85b150?w=200&q=80",
        banner: "https://images.unsplash.com/photo-1488459716781-31db52582fe9?w=800&q=75",
        bio: "Farm-to-table fresh produce. Direct from Limuru & Muranga farms. Same-day delivery. Avocados, vegetables, eggs, milk & more. No preservatives, always fresh.",
        categories: ["food", "agriculture"],
        rating: 4.9, reviews: 89, followers: 211, verified: true,
        joinedAt: "Feb 2026", orders: 534, responseTime: "Under 10 min",
        badge: "Certified Fresh", badgeColor: "#10b981"
      },
      {
        id: "SHOP003", name: "Kaspa Prints", email: "kaspa@sokoni.ke",
        phone: "0733345003", location: "Industrial Area, Nairobi",
        logo: "https://images.unsplash.com/photo-1561070791-2526d30994b5?w=200&q=80",
        banner: "https://images.unsplash.com/photo-1586717791821-3f44a563fa4c?w=800&q=75",
        bio: "Nairobi's fastest print shop. T-shirts, business cards, banners, branded polo shirts & flyers. Full colour, 24-hour printing. Design help included free.",
        categories: ["printing", "graphic-design"],
        rating: 4.9, reviews: 214, followers: 489, verified: true,
        joinedAt: "Dec 2025", orders: 876, responseTime: "Under 2 min",
        badge: "Power Seller", badgeColor: "#f59e0b"
      }
    ]));
  }

  /* ═══════════════════════════════════════════════════════════
     22. TEST ACCOUNTS  — 4 demo logins for client testing
         (localStorage accounts — work without Firebase sign-in)
  ═══════════════════════════════════════════════════════════ */
  /* Demo password for all test accounts — plain text is fine, these are local test-only accounts */
  var _demoPass = "Demo1234!";
  var _testAccounts = [
    { name:"Amina Buyer",  email:"buyer@test.sokoni.co.ke",  password:_demoPass, roles:{buyer:true},               phone:"0712001001" },
    { name:"Brian Seller", email:"seller@test.sokoni.co.ke", password:_demoPass, roles:{buyer:true,seller:true},   phone:"0722001002", shopName:"Brian's Shop" },
    { name:"Caro Driver",  email:"driver@test.sokoni.co.ke", password:_demoPass, roles:{buyer:true,driver:true},   phone:"0733001003" },
    { name:"Diana Health", email:"health@test.sokoni.co.ke", password:_demoPass, roles:{buyer:true,healthcare:true},phone:"0744001004" }
  ];
  /* Save accounts index so login.html can find them */
  if (!localStorage.getItem("sokoniTestAccounts")) {
    localStorage.setItem("sokoniTestAccounts", JSON.stringify(_testAccounts));
  }
  /* ── sokoniFeaturedShops  — show the Featured Shops section on home page ── */
  if (!localStorage.getItem("sokoniFeaturedShops")) {
    var _boostEnd = NOW + 30 * DAY;
    localStorage.setItem("sokoniFeaturedShops", JSON.stringify([
      {
        storeName: "Sokoni Electronics", logo: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=120&q=80",
        storeUrl: "ministore.html?seller=Sokoni+Electronics",
        avgRating: 4.8, location: "nairobi",
        tagline: "Samsung, Sony, Apple & more — 1-yr warranty", productCount: 28,
        endsAt: _boostEnd
      },
      {
        storeName: "Green Farm Kenya", logo: "https://images.unsplash.com/photo-1550583724-b2692b85b150?w=120&q=80",
        storeUrl: "ministore.html?seller=Green+Farm+Kenya",
        avgRating: 4.9, location: "nairobi",
        tagline: "Farm-fresh produce, same-day delivery", productCount: 14,
        endsAt: _boostEnd
      },
      {
        storeName: "Kaspa Prints", logo: "https://images.unsplash.com/photo-1561070791-2526d30994b5?w=120&q=80",
        storeUrl: "ministore.html?seller=Kaspa+Prints",
        avgRating: 4.9, location: "nairobi",
        tagline: "T-shirts, banners, business cards — 24h print", productCount: 11,
        endsAt: _boostEnd
      }
    ]));
  }

  localStorage.setItem("sokoniDemoSeeded", "7");
  console.log("✅ SOKONI Demo v7 seeded — shops, football fixtures & client testing data ready!");

})();
