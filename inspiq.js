/**
 * InspIQ v2 — Pinterest-style Infinite Personalized Feed
 * Tracks interest signals across the whole site and serves an
 * unlimited, weighted, interest-driven content stream.
 */
(function () {
  const STORE_KEY   = 'sokoniInspIQ';
  const SESSION_KEY = 'inspiqNotifShown';
  const SHOWN_KEY   = 'inspiqShownTitles'; // sessionStorage dedup
  const PAGE_SIZE   = 12;

  /* ─── CATEGORY DEFINITIONS ─── */
  const CATS = {
    food:          { label:'Food & Groceries',  emoji:'🍎', color:'#ff6b35' },
    electronics:   { label:'Electronics',        emoji:'📱', color:'#00aaff' },
    fashion:       { label:'Fashion',             emoji:'👗', color:'#ec4899' },
    beauty:        { label:'Beauty',              emoji:'💄', color:'#f43f5e' },
    furniture:     { label:'Home & Living',       emoji:'🏠', color:'#22c55e' },
    sports:        { label:'Sports & Fitness',    emoji:'⚽', color:'#16a34a' },
    automotive:    { label:'Cars & Auto',         emoji:'🚗', color:'#3b82f6' },
    healthcare:    { label:'Healthcare',          emoji:'🏥', color:'#06b6d4' },
    entertainment: { label:'Entertainment',       emoji:'🎬', color:'#a855f7' },
    luxury:        { label:'Luxury & Premium',    emoji:'💎', color:'#f59e0b' },
    books:         { label:'Books & Learning',    emoji:'📚', color:'#a8ff58' },
    agriculture:   { label:'Agriculture',         emoji:'🌾', color:'#65a30d' },
    construction:  { label:'Construction',        emoji:'🏗️', color:'#d97706' },
    property:      { label:'Property & Housing',  emoji:'🏘️', color:'#0ea5e9' },
    travel:        { label:'Travel & Tourism',    emoji:'✈️', color:'#14b8a6' },
    baby:          { label:'Baby & Kids',         emoji:'🍼', color:'#f97316' },
    pets:          { label:'Pets & Animals',      emoji:'🐾', color:'#84cc16' },
    finance:       { label:'Finance & Banking',   emoji:'💰', color:'#eab308' },
  };

  /* ─── PERSONAS ─── */
  const PERSONAS = {
    foodie:      { name:'Foodie',       emoji:'🍽️', cats:['food'],                          tip:'fresh food deals & restaurants near you' },
    techie:      { name:'Tech Lover',   emoji:'💻', cats:['electronics'],                    tip:'gadget drops, phone deals & tech news' },
    fashionista: { name:'Fashionista',  emoji:'👠', cats:['fashion','beauty','luxury'],       tip:'style drops, beauty trends & looks' },
    homebody:    { name:'Home Maker',   emoji:'🏡', cats:['furniture','construction'],        tip:'furniture, decor & home improvement' },
    athlete:     { name:'Athlete',      emoji:'🏅', cats:['sports','healthcare'],             tip:'sports gear, supplements & wellness' },
    driver:      { name:'Car Lover',    emoji:'🚗', cats:['automotive'],                     tip:'auto parts, rentals & car services' },
    scholar:     { name:'Scholar',      emoji:'🎓', cats:['books'],                          tip:'books, online courses & stationery' },
    farmer:      { name:'Agri-Preneur',emoji:'🌾', cats:['agriculture'],                    tip:'farm inputs, equipment & market prices' },
    explorer:    { name:'Entertainer',  emoji:'🎉', cats:['entertainment','travel'],          tip:'events, DJs, tickets & experiences' },
    investor:    { name:'Investor',     emoji:'🏦', cats:['property','finance'],              tip:'land, rental properties & real estate' },
    builder:     { name:'Builder',      emoji:'🔧', cats:['construction'],                   tip:'building materials, tools & contractors' },
    parent:      { name:'Parent',       emoji:'👶', cats:['baby','healthcare'],               tip:'baby products, kids gear & parenting tips' },
    petlover:    { name:'Pet Lover',    emoji:'🐾', cats:['pets'],                           tip:'pet food, vet services & accessories' },
    traveller:   { name:'Traveller',    emoji:'🌍', cats:['travel','luxury'],                 tip:'safari deals, flights & hotel packages' },
  };

  /* ─── MASSIVE CONTENT POOL ─── */
  const POOL = {
    food: [
      { title:'🍔 Daily Meal Deals — Up to 40% Off',     sub:'Order from top Nairobi restaurants',           href:'food.html',               tag:'Hot Deal',    img:'🍽️' },
      { title:'🛒 Weekly Grocery Bundles',               sub:'Fresh produce delivered to your door',          href:'category.html?cat=food',  tag:'Fresh Picks', img:'🥦' },
      { title:'🍕 Pizza Night Specials',                 sub:'Choose from 20+ pizza sellers near you',       href:'food.html',               tag:'Tonight',     img:'🍕' },
      { title:'☕ Morning Coffee & Breakfast Deals',     sub:'Start your day right — deals from local cafes', href:'food.html',               tag:'Morning',     img:'☕' },
      { title:'🍗 Nyama Choma Deals Near You',          sub:'Grills, joints & delivery services',            href:'food.html',               tag:'Weekend',     img:'🔥' },
      { title:'🥗 Healthy Meal Plans',                  sub:'Nutritionist-approved weekly boxes from KES 1,500', href:'food.html',           tag:'Wellness',    img:'🥗' },
      { title:'🌮 Street Food Specials',                sub:'Samosas, mandazi, mutura & more near you',       href:'food.html',               tag:'Street Food', img:'🌮' },
      { title:'🍱 Lunch Box Deliveries',               sub:'Office & school lunch delivered by 12PM',         href:'food.html',               tag:'Lunch',       img:'🍱' },
      { title:'🥩 Butchery — Fresh Meat Packs',        sub:'Beef, pork & chicken bulk packs at farm prices',  href:'category.html?cat=food',  tag:'Fresh',       img:'🥩' },
      { title:'🫙 Spices & Condiments Superstore',    sub:'Royco, Mchuzi Mix, Pilau masala & more',           href:'category.html?cat=food',  tag:'Flavour',     img:'🫙' },
      { title:'🥛 Dairy & Eggs Delivered Daily',      sub:'Fresh milk, yoghurt & eggs from KES 60',           href:'category.html?cat=food',  tag:'Daily Fresh', img:'🥛' },
      { title:'🍰 Cakes & Pastries on Demand',        sub:'Custom cakes for birthdays & events',              href:'food.html',               tag:'Celebrate',   img:'🎂' },
      { title:'🫕 Soup & Stew Packs',                sub:'Githeri, pilau, biriani meal kits — ready in 20 min', href:'food.html',             tag:'Comfort',     img:'🫕' },
      { title:'🍣 Sushi & Japanese Near You',         sub:'Nairobi sushi restaurants with free delivery',     href:'food.html',               tag:'Premium',     img:'🍣' },
      { title:'🥬 Organic Farm Box Weekly',          sub:'100% organic vegetables from Limuru farms',         href:'category.html?cat=food',  tag:'Organic',     img:'🌱' },
      { title:'🍦 Desserts & Ice Cream Deals',       sub:'Local ice cream shops & dessert delivery',          href:'food.html',               tag:'Sweet',       img:'🍦' },
      { title:'🍺 Drinks & Beverages Delivery',      sub:'Sodas, juices, water & energy drinks in bulk',     href:'category.html?cat=food',  tag:'Drinks',      img:'🥤' },
      { title:'🫔 Chapati & Bhajia Combos',          sub:'Kenyan street combos from local vendors',          href:'food.html',               tag:'Kenyan',      img:'🫔' },
      { title:'🍜 Instant Noodles & Easy Meals',     sub:'Indomie, pasta, quick meals from KES 50',          href:'category.html?cat=food',  tag:'Quick',       img:'🍜' },
      { title:'🏪 Supermarket Price Wars',           sub:'Naivas, Carrefour & Quickmart compared on Sokoni', href:'category.html?cat=food',  tag:'Compare',     img:'🏪' },
      { title:'🫒 Import Foods & Specialty Items',  sub:'Olive oil, pasta, international brands delivered',   href:'category.html?cat=food',  tag:'Imported',    img:'🌍' },
      { title:'🥦 Vegetarian & Vegan Deals',         sub:'Plant-based meals & products in Nairobi',          href:'food.html',               tag:'Plant-Based', img:'🥦' },
    ],
    electronics: [
      { title:'📱 Smartphones — Best Prices Kenya',    sub:'iPhone, Samsung, Tecno · Sealed with warranty',   href:'category.html?cat=electronics', tag:'Hot',         img:'📱' },
      { title:'💻 Refurbished Laptops Under KES 30K', sub:'Certified refurbs from top sellers',               href:'category.html?cat=electronics', tag:'Budget Pick', img:'💻' },
      { title:'🎧 Wireless Earbuds Blowout',          sub:'Airpods alternatives from KES 1,200',              href:'category.html?cat=electronics', tag:'Save Big',    img:'🎧' },
      { title:'🔌 Smart Home Gadgets',                sub:'Smart bulbs, plugs & security cameras',            href:'category.html?cat=electronics', tag:'New Arrival', img:'🏠' },
      { title:'📷 Cameras & Video Gear',              sub:'DSLR, mirrorless & action cameras — all brands',   href:'category.html?cat=electronics', tag:'Creator Picks', img:'📷' },
      { title:'🖥️ Gaming Setup Bundle',              sub:'PC, consoles, controllers & accessories',           href:'category.html?cat=electronics', tag:'Level Up',    img:'🎮' },
      { title:'⌚ Smartwatches & Fitness Bands',      sub:'Fitbit, Samsung Galaxy Watch from KES 3,500',      href:'category.html?cat=electronics', tag:'Wearables',   img:'⌚' },
      { title:'🖨️ Printers & Ink Cartridges',       sub:'HP, Canon, Epson — originals & compatible ink',    href:'category.html?cat=electronics', tag:'Office',      img:'🖨️' },
      { title:'📺 Smart TVs Mega Sale',              sub:'32" to 75" — Samsung, LG, Hisense from KES 12K',   href:'category.html?cat=electronics', tag:'Big Screen',  img:'📺' },
      { title:'🔋 Power Banks & Solar Chargers',     sub:'10,000–30,000mAh power banks from KES 1,000',      href:'category.html?cat=electronics', tag:'Stay Charged', img:'🔋' },
      { title:'💡 LED Lighting & Smart Bulbs',       sub:'Energy-saving bulbs & RGB smart lighting sets',    href:'category.html?cat=electronics', tag:'Save Energy', img:'💡' },
      { title:'🎙️ Microphones & Recording Gear',    sub:'Condenser mics, audio interfaces for creators',    href:'category.html?cat=electronics', tag:'Creator',     img:'🎙️' },
      { title:'📡 WiFi Routers & Modems',           sub:'Boost your home internet speed — all ISPs',         href:'category.html?cat=electronics', tag:'Fast WiFi',   img:'📡' },
      { title:'🕹️ Gaming Chairs & Desks',          sub:'Ergonomic gaming stations from KES 8,000',          href:'category.html?cat=electronics', tag:'Gamer Setup', img:'🕹️' },
      { title:'🔧 Phone Repair Kits',               sub:'Screen, battery & tools for DIY phone repairs',    href:'category.html?cat=electronics', tag:'Fix It',      img:'🔧' },
      { title:'💾 Storage Deals — SSD & Hard Drives',sub:'1TB SSD from KES 5,000 · External drives in stock', href:'category.html?cat=electronics', tag:'Storage',    img:'💾' },
      { title:'🎵 Home Theatre Systems',             sub:'Soundbars, subwoofers & 5.1 systems from KES 6K',  href:'category.html?cat=electronics', tag:'Sound',       img:'🔊' },
      { title:'📸 Drone Photography Deals',          sub:'DJI & budget drones for aerial photography',       href:'category.html?cat=electronics', tag:'Aerial',      img:'🚁' },
      { title:'⌨️ Keyboards & Gaming Peripherals',  sub:'Mechanical, RGB, wireless — all budgets',           href:'category.html?cat=electronics', tag:'Peripherals', img:'⌨️' },
      { title:'🖱️ Office Gadgets Under KES 2K',    sub:'Mice, USB hubs, cables & accessories',              href:'category.html?cat=electronics', tag:'Office',      img:'🖱️' },
    ],
    fashion: [
      { title:'👗 Trending Styles This Season',      sub:'New arrivals from Nairobi designers',              href:'category.html?cat=fashion', tag:'Trending',        img:'👗' },
      { title:'👠 Heels & Flats — 30% Off',         sub:'Office and casual shoes for every occasion',       href:'category.html?cat=fashion', tag:'Flash Deal',       img:'👠' },
      { title:'🧥 Men\'s Formal Collection',         sub:'Suits, blazers & shirts for the modern man',      href:'category.html?cat=fashion', tag:'New In',           img:'🧥' },
      { title:'👟 Sneaker Drop — Limited Editions',  sub:'Nike, Adidas, Jordan & Kenyan-made kicks',        href:'category.html?cat=fashion', tag:'Limited',          img:'👟' },
      { title:'👒 Accessories & Bags',              sub:'Belts, wallets, handbags & watches',               href:'category.html?cat=accessories', tag:'Complete the Look', img:'👜' },
      { title:'🧴 Back-to-School Uniform Deals',    sub:'School uniforms, shoes & bags for all ages',       href:'category.html?cat=fashion', tag:'School Season',    img:'🎒' },
      { title:'👘 African Print & Kitenge Fashion', sub:'Bold prints, buibui, khangas from local tailors',  href:'category.html?cat=fashion', tag:'African Style',    img:'🌍' },
      { title:'🧣 Winter Warmers Collection',       sub:'Jackets, hoodies, sweaters for cold season',       href:'category.html?cat=fashion', tag:'Stay Warm',        img:'🧣' },
      { title:'💍 Jewellery & Accessories',         sub:'Gold, silver & fashion jewellery from KES 300',    href:'category.html?cat=accessories', tag:'Accessorize',  img:'💍' },
      { title:'👔 Work Wear Collection',            sub:'Professional attire for offices and interviews',    href:'category.html?cat=fashion', tag:'Career Ready',     img:'👔' },
      { title:'👙 Swimwear & Beachwear',            sub:'Bikinis, boardshorts & beach accessories',         href:'category.html?cat=fashion', tag:'Beach Ready',      img:'🏖️' },
      { title:'🧤 Sportswear & Activewear',         sub:'Leggings, sports bras, shorts & running gear',    href:'category.html?cat=fashion', tag:'Active',           img:'🧤' },
      { title:'🪡 Custom Tailoring Services',       sub:'Get clothes made to measure — find tailors near you', href:'services.html',          tag:'Custom Made',      img:'✂️' },
      { title:'👶 Children\'s Clothing Sale',       sub:'Dresses, trousers & shoes for toddlers to teens', href:'category.html?cat=fashion', tag:'Kids Sale',        img:'🧒' },
      { title:'🎩 Hats, Caps & Headwear',          sub:'Snapbacks, fedoras, beanies & sun hats',           href:'category.html?cat=accessories', tag:'Top It Off',   img:'🎩' },
      { title:'👞 Shoe Clearance — All Sizes',      sub:'Men\'s & women\'s shoes from KES 700',             href:'category.html?cat=fashion', tag:'Clearance',        img:'👞' },
      { title:'🌙 Party & Evening Wear',            sub:'Cocktail dresses, suits & formal gowns',           href:'category.html?cat=fashion', tag:'Party Ready',      img:'✨' },
      { title:'🎽 Team Jerseys & Sports Kits',      sub:'Football, basketball & rugby kits — custom printing', href:'category.html?cat=fashion', tag:'Team Kits',     img:'🎽' },
      { title:'🧺 Vintage & Secondhand Fashion',   sub:'Mitumba gems & thrift finds from KES 100',         href:'category.html?cat=fashion', tag:'Thrift',           img:'♻️' },
      { title:'👜 Handbag Flash Sale — 24hrs Only', sub:'Tote, clutch & shoulder bags up to 50% off',      href:'category.html?cat=fashion', tag:'24hr Flash',       img:'👜' },
    ],
    beauty: [
      { title:'💄 Top Skincare Brands on Sokoni',   sub:'Serums, moisturizers & sunscreens',                href:'category.html?cat=beauty', tag:'Bestseller',  img:'🧴' },
      { title:'💅 Nail Art Kits & Accessories',     sub:'Professional nail sets from KES 500',              href:'category.html?cat=beauty', tag:'Popular',     img:'💅' },
      { title:'🌸 Perfumes & Body Mists',           sub:'Designer dupes & originals from KES 800',          href:'category.html?cat=beauty', tag:'Fragrance',   img:'🌸' },
      { title:'💋 Makeup Mega Sale',                sub:'Foundations, lipsticks & eyeshadow palettes',     href:'category.html?cat=beauty', tag:'Sale',        img:'💋' },
      { title:'🌿 Natural Hair & Scalp Care',       sub:'Oils, butters & protective styles',                href:'category.html?cat=beauty', tag:'Natural',     img:'🌿' },
      { title:'🧖 Spa & Salon Services',            sub:'Book facials, massages & waxing near you',         href:'services.html',           tag:'Book Now',    img:'✨' },
      { title:'🪷 Rosewater & Toner Collection',   sub:'Hydrating toners for all skin types from KES 350', href:'category.html?cat=beauty', tag:'Hydrate',     img:'🪷' },
      { title:'☀️ Sunscreen & SPF Products',        sub:'SPF 30–100 for Kenyan skin — dermatologist picks', href:'category.html?cat=beauty', tag:'Sun Safety',  img:'☀️' },
      { title:'💆 Deep Conditioning Hair Masks',    sub:'Restore damaged hair with salon-grade masks',      href:'category.html?cat=beauty', tag:'Hair Care',   img:'💆' },
      { title:'🧼 Organic Soaps & Body Wash',       sub:'Shea butter, kojic, charcoal soaps from KES 150', href:'category.html?cat=beauty', tag:'Organic',     img:'🧼' },
      { title:'👁️ Eye Lashes & Brow Kits',          sub:'Falsies, serums & brow pomades for bold looks',   href:'category.html?cat=beauty', tag:'Bold Eyes',   img:'👁️' },
      { title:'🪴 Aloe Vera & Herbal Beauty',      sub:'100% natural Kenyan herbal beauty products',        href:'category.html?cat=beauty', tag:'Herbal',      img:'🌵' },
      { title:'🎨 Henna & Body Art Supplies',      sub:'Professional henna kits, stencils & mehendi',      href:'category.html?cat=beauty', tag:'Artistic',    img:'🎨' },
      { title:'💇 Hair Weaves & Extensions',        sub:'Brazilian, Peruvian & synthetic hair from KES 800', href:'category.html?cat=beauty', tag:'Extensions', img:'💇' },
      { title:'🧴 Men\'s Grooming Kits',            sub:'Beard oils, shavers, moisturizers for men',        href:'category.html?cat=beauty', tag:'Men\'s',      img:'🪒' },
      { title:'🌺 Luxury Skincare Sets',            sub:'Premium serums & creams — gift-ready boxes',       href:'category.html?cat=beauty', tag:'Luxury',      img:'🎁' },
      { title:'💊 Beauty Supplements',              sub:'Collagen, biotin & vitamin C for skin & hair',     href:'healthcare.html',         tag:'Glow From Within', img:'💊' },
      { title:'🖌️ Nail Polish Haul — 50+ Shades',  sub:'OPI, Essie & local brands in all finishes',       href:'category.html?cat=beauty', tag:'Colour Your Mood', img:'🖌️' },
      { title:'🧳 Travel Beauty Kits',              sub:'TSA-approved mini sets for frequent travellers',   href:'category.html?cat=beauty', tag:'Travel',      img:'🧳' },
      { title:'🌟 Celebrity Skin Routines on Sokoni', sub:'Product stacks inspired by top Kenyan celebs', href:'category.html?cat=beauty',  tag:'Celeb Picks', img:'⭐' },
    ],
    furniture: [
      { title:'🛋️ Transform Your Living Room',       sub:'Sofa sets from KES 25,000 — delivery included',  href:'category.html?cat=furniture', tag:'Best Value', img:'🛋️' },
      { title:'🛏️ Bedroom Sets on Sale',             sub:'Bed frames, mattresses & wardrobes',              href:'category.html?cat=furniture', tag:'Deal',       img:'🛏️' },
      { title:'🪑 Ergonomic Office Chairs',          sub:'Work-from-home essentials from KES 5K',           href:'category.html?cat=furniture', tag:'WFH Pick',   img:'🪑' },
      { title:'🌿 Indoor Plants & Ceramic Pots',     sub:'Brighten your space — from KES 350',              href:'category.html?cat=furniture', tag:'New',        img:'🌿' },
      { title:'🍳 Kitchen Appliances Clearance',     sub:'Blenders, microwaves, air fryers — all brands',   href:'category.html?cat=appliances', tag:'Clearance', img:'🏠' },
      { title:'🔧 Home Repairs & Installations',     sub:'Plumbers, electricians & handymen near you',      href:'services.html',               tag:'Fix It',     img:'🔧' },
      { title:'🚿 Bathroom Fittings & Accessories',  sub:'Shower units, towel rails & vanity mirrors',      href:'category.html?cat=furniture', tag:'Refresh',    img:'🚿' },
      { title:'🪞 Wall Mirrors & Decor Frames',     sub:'Full-length, decorative & LED mirrors from KES 1K', href:'category.html?cat=furniture', tag:'Decor',    img:'🪞' },
      { title:'🖼️ Wall Art & Canvas Prints',        sub:'Kenyan landscapes, abstract & custom prints',     href:'category.html?cat=furniture', tag:'Art',        img:'🖼️' },
      { title:'🛁 Jacuzzi & Bathtub Deals',         sub:'Freestanding & built-in bathtubs from KES 30K',   href:'category.html?cat=furniture', tag:'Luxury',     img:'🛁' },
      { title:'🪟 Curtains & Blinds',               sub:'Blackout, sheer & roller blinds for every room',  href:'category.html?cat=furniture', tag:'Window Style', img:'🪟' },
      { title:'🍽️ Dining Tables & Chair Sets',      sub:'4, 6, 8-seater dining sets from KES 15,000',     href:'category.html?cat=furniture', tag:'Dining',     img:'🍽️' },
      { title:'📦 Storage Boxes & Organisers',      sub:'Closet, kitchen & office organisers from KES 300', href:'category.html?cat=furniture', tag:'Organise',  img:'📦' },
      { title:'🪴 Garden & Outdoor Furniture',      sub:'Patio sets, hammocks & garden chairs',            href:'category.html?cat=furniture', tag:'Outdoor',    img:'🏡' },
      { title:'💡 Pendant Lights & Chandeliers',    sub:'Modern & classic lighting for every room',        href:'category.html?cat=furniture', tag:'Illuminate', img:'💡' },
      { title:'🛒 Supermarket Trolley Furniture Haul', sub:'Flash clearance on selected furniture items',  href:'category.html?cat=furniture', tag:'Flash Deal', img:'🏷️' },
      { title:'🏗️ Flat-Pack Furniture Delivered',  sub:'IKEA-style self-assembly pieces from KES 3K',      href:'category.html?cat=furniture', tag:'Easy Build', img:'🔨' },
      { title:'🧹 Cleaning Supplies Bulk Pack',     sub:'Mops, brooms, vacuum cleaners & surface sprays',  href:'category.html?cat=appliances', tag:'Clean Home', img:'🧹' },
      { title:'🌡️ Air Conditioners & Cooling Fans', sub:'Split units & standing fans — beat the heat',    href:'category.html?cat=appliances', tag:'Stay Cool', img:'❄️' },
      { title:'🪣 Water Storage Tanks & Pumps',     sub:'Polytanks, submersible pumps & water bowsers',    href:'category.html?cat=furniture', tag:'Water',      img:'💧' },
    ],
    sports: [
      { title:'⚽ Football Gear Mega Sale',          sub:'Jerseys, boots & balls — all brands',              href:'sports-hub.html',           tag:'Game Day',   img:'⚽' },
      { title:'🏋️ Home Gym Equipment',              sub:'Dumbbells, benches & resistance bands',            href:'category.html?cat=sports',  tag:'Train Hard', img:'🏋️' },
      { title:'🏃 Running Shoes — Top Brands',      sub:'Nike, Adidas, Saucony on Sokoni',                  href:'category.html?cat=sports',  tag:'Race Ready', img:'👟' },
      { title:'🏟️ Book a Sports Court',             sub:'Turf, tennis & basketball — near you',             href:'sports-hub.html',           tag:'Book Now',   img:'🏟️' },
      { title:'🥊 Boxing & Martial Arts Gear',      sub:'Gloves, wraps, bags & mats',                       href:'category.html?cat=sports',  tag:'Fight Ready', img:'🥊' },
      { title:'🧘 Yoga Mats & Studio Classes',      sub:'Premium mats from KES 1,200 · Online classes',    href:'category.html?cat=sports',  tag:'Mindful',    img:'🧘' },
      { title:'🏊 Swimming Gear & Pool Access',     sub:'Goggles, caps & swim clubs near you',              href:'sports-hub.html',           tag:'Swim',       img:'🏊' },
      { title:'🚴 Bicycles & Cycling Gear',         sub:'Road, mountain & city bikes from KES 7,000',      href:'category.html?cat=sports',  tag:'Ride',       img:'🚴' },
      { title:'🎾 Tennis Rackets & Court Hire',     sub:'Rackets from KES 1,500 · Court bookings near you', href:'sports-hub.html',           tag:'Ace It',     img:'🎾' },
      { title:'🏈 Rugby & American Football Kits',  sub:'Training gear, pads & match jerseys',              href:'category.html?cat=sports',  tag:'Rugby',      img:'🏈' },
      { title:'⛳ Golf Equipment & Lessons',         sub:'Clubs, bags & driving range bookings in Nairobi', href:'sports-hub.html',           tag:'Golf',       img:'⛳' },
      { title:'🥋 BJJ & Karate Classes Near You',  sub:'Find martial arts academies & dojos',               href:'sports-hub.html',           tag:'Martial Arts', img:'🥋' },
      { title:'🏄 Hiking & Outdoor Adventure Gear', sub:'Boots, tents, backpacks & climbing gear',         href:'category.html?cat=sports',  tag:'Adventure',  img:'🏔️' },
      { title:'🏇 Motorsport & Go-Karting',         sub:'Track days, kart hire & motorsport gear',          href:'sports-hub.html',           tag:'Speed',      img:'🏎️' },
      { title:'💪 Protein & Sports Nutrition',      sub:'Whey, creatine & pre-workout from KES 1,200',     href:'healthcare.html',           tag:'Fuel Up',    img:'💪' },
      { title:'⚾ Cricket & Baseball Equipment',    sub:'Bats, balls, wickets & helmets for teams',          href:'category.html?cat=sports',  tag:'Cricket',    img:'⚾' },
      { title:'🥅 Goalkeeper Kits & Gloves',        sub:'Pro-grade gloves, padded shorts & keeper jerseys', href:'category.html?cat=sports',  tag:'Between The Posts', img:'🥅' },
      { title:'🛹 Skateboarding & Rollerskating',  sub:'Boards, pads & rollerskates for all ages',          href:'category.html?cat=sports',  tag:'Skate',      img:'🛹' },
      { title:'🎿 Water Sports Equipment',          sub:'Kayak, paddleboard, snorkel gear on Lake Victoria', href:'sports-hub.html',           tag:'Water Sports', img:'🛶' },
      { title:'🧗 Climbing & Bouldering Gear',      sub:'Harnesses, shoes & chalk bags — indoor & outdoor', href:'category.html?cat=sports',  tag:'Climb',      img:'🧗' },
    ],
    automotive: [
      { title:'🚗 Car Parts at Wholesale Prices',   sub:'Genuine & aftermarket parts for all models',      href:'car-hub.html',     tag:'Hot',       img:'🔧' },
      { title:'🚙 Car Rentals From KES 3,500/day', sub:'Self-drive & chauffeur options available',         href:'car-rental.html',  tag:'Road Trip', img:'🗺️' },
      { title:'🔩 Find a Mechanic Near You',        sub:'Certified mechanics in Nairobi & Mombasa',        href:'mechanics.html',   tag:'Trusted',   img:'🔩' },
      { title:'📋 NTSA Services Online',            sub:'DL renewal, TIMS, insurance — all in one',        href:'car-hub.html',     tag:'NTSA',      img:'📋' },
      { title:'🚘 Buy & Sell Used Cars',            sub:'Verified listings from private owners & dealers', href:'car-hub.html',     tag:'Deals',     img:'🚘' },
      { title:'🛡️ Car Insurance — Instant Quote',  sub:'Third party & comprehensive from KES 8K/yr',      href:'car-hub.html',     tag:'Protect',   img:'🛡️' },
      { title:'⛽ Fuel Cards & Discounts',          sub:'Save on petrol — Shell, Total & Rubis partner deals', href:'car-hub.html', tag:'Save',      img:'⛽' },
      { title:'🔦 Car Accessories Store',           sub:'Seat covers, dash cams, car mats & wipers',      href:'car-hub.html',     tag:'Accessory', img:'🔦' },
      { title:'🔋 Car Batteries — Replace Today',  sub:'Amaron, Yuasa, Deka — fitting included free',      href:'mechanics.html',   tag:'Battery',   img:'🔋' },
      { title:'🚕 Hire a Driver for the Day',       sub:'Professional drivers from KES 2,000 — CBDs & airport', href:'driver.html', tag:'Chauffeured', img:'🚕' },
      { title:'🏍️ Motorbikes & Boda Boda Deals',   sub:'Bajaj, Hero & TVS from KES 80,000 with financing', href:'car-hub.html',   tag:'Boda',      img:'🏍️' },
      { title:'🔧 Tyre Change & Alignment',         sub:'Book tyre fitting, balancing & alignment nearby', href:'mechanics.html',   tag:'Tyres',     img:'🔧' },
      { title:'🚐 Matatu & Bus Hire for Events',   sub:'8–33 seater vehicles for day trips & functions',   href:'car-rental.html',  tag:'Group Travel', img:'🚐' },
      { title:'🧼 Car Wash & Detailing Services',  sub:'Professional car wash from KES 500 near you',      href:'services.html',    tag:'Clean Car', img:'🧼' },
      { title:'🌍 GPS Tracking Installation',       sub:'Real-time vehicle tracking from KES 3,500 one-off', href:'car-hub.html',   tag:'Track',     img:'📡' },
      { title:'🔆 Car Lights & LED Upgrades',       sub:'Headlights, taillights & neon underglow kits',    href:'car-hub.html',     tag:'Light Up',  img:'💡' },
      { title:'🚛 Truck & Commercial Vehicle Parts', sub:'Lorry spares, trailer parts & heavy-duty fittings', href:'car-hub.html', tag:'Commercial', img:'🚛' },
      { title:'🎵 Car Audio & Entertainment',       sub:'Stereos, subwoofers & car displays — all brands', href:'car-hub.html',     tag:'Sound',     img:'🎵' },
      { title:'🏁 Car Performance Upgrades',        sub:'Air filters, exhaust tips, spoilers & tuning kits', href:'car-hub.html',  tag:'Tune Up',   img:'🏁' },
      { title:'🛻 4x4 Accessories & Lift Kits',    sub:'Bull bars, roof racks, snorkels for off-road builds', href:'car-hub.html', tag:'Off-Road',  img:'🛻' },
    ],
    healthcare: [
      { title:'🏥 Book a Doctor Online',            sub:'GP consultations from KES 500 — same day',        href:'healthcare.html', tag:'Health First', img:'👨‍⚕️' },
      { title:'💊 Medicine & Pharmacy Delivery',    sub:'Prescription & OTC meds delivered fast',          href:'healthcare.html', tag:'Delivery',    img:'💊' },
      { title:'🩺 Lab Tests at Home',               sub:'Blood work & diagnostics without the queue',      href:'healthcare.html', tag:'New',         img:'🩺' },
      { title:'🧘 Mental Health & Wellness',        sub:'Therapists, yoga instructors & life coaches',     href:'healthcare.html', tag:'Wellness',    img:'🧘' },
      { title:'🦷 Dental Services Near You',        sub:'Checkups, fillings & whitening from KES 1,500',  href:'healthcare.html', tag:'Smile',       img:'🦷' },
      { title:'🏃 Fitness Trainers & Dieticians',  sub:'Personal coaching sessions — online or in-person', href:'healthcare.html', tag:'Get Fit',     img:'💪' },
      { title:'👁️ Eye Care & Opticians Near You',  sub:'Eye tests, prescription glasses & contact lenses', href:'healthcare.html', tag:'Vision',     img:'👁️' },
      { title:'🤰 Maternity & Antenatal Care',     sub:'Specialist OBGYNs, clinics & birth packages',     href:'healthcare.html', tag:'Maternity',   img:'🤱' },
      { title:'💉 Vaccines & Immunisation',         sub:'Yellow fever, travel vaccines & routine jabs',    href:'healthcare.html', tag:'Vaccinate',   img:'💉' },
      { title:'🧪 STI / STD Testing — Private',    sub:'Confidential tests at home or at partner clinics', href:'healthcare.html', tag:'Private',    img:'🧪' },
      { title:'💆 Massage & Physiotherapy',         sub:'Therapeutic massages & physio sessions near you', href:'services.html',   tag:'Recovery',    img:'💆' },
      { title:'🩻 X-Ray & Imaging Services',        sub:'Affordable radiology services in Nairobi',       href:'healthcare.html', tag:'Diagnostics', img:'🩻' },
      { title:'🩹 First Aid Kits & Supplies',       sub:'Home, office & car first aid kits from KES 600', href:'healthcare.html', tag:'Safety',      img:'🩹' },
      { title:'🧬 DNA Testing Services',            sub:'Paternity, ancestry & health DNA tests in Kenya', href:'healthcare.html', tag:'DNA',         img:'🧬' },
      { title:'🏋️ Gym Membership Deals',           sub:'Month & annual gym passes near you from KES 1,500', href:'sports-hub.html', tag:'Gym',       img:'🏋️' },
      { title:'🌿 Herbal & Alternative Medicine',  sub:'Naturopath, acupuncture & holistic healing',      href:'healthcare.html', tag:'Holistic',    img:'🌿' },
      { title:'👶 Child Vaccination Records',       sub:'Track & book all childhood vaccines digitally',   href:'healthcare.html', tag:'Kids Health', img:'👶' },
      { title:'🦴 Orthopaedic & Joint Specialists', sub:'Knee, back & spine specialists in Nairobi',      href:'healthcare.html', tag:'Ortho',       img:'🦴' },
      { title:'🩺 Diabetes & Chronic Disease Care', sub:'Specialist management, monitors & medication',   href:'healthcare.html', tag:'Chronic Care', img:'📊' },
      { title:'🚑 24hr Emergency Services',         sub:'Ambulance, emergency doctors & urgent care near you', href:'healthcare.html', tag:'Emergency', img:'🚑' },
    ],
    entertainment: [
      { title:'🎵 Book a DJ for Your Event',        sub:'Verified DJs for parties, weddings & corporates', href:'entertainment.html', tag:'Book Now',   img:'🎧' },
      { title:'📸 Hire a Photographer',             sub:'Professional shoots from KES 5,000',              href:'entertainment.html', tag:'Capture',    img:'📸' },
      { title:'🎭 Comedy Night Tickets',            sub:'Stand-up shows in Nairobi & Mombasa',             href:'entertainment.html', tag:'LOL',        img:'🎭' },
      { title:'🎂 Party Planning Services',         sub:'Catering, decor & entertainment bundles',         href:'entertainment.html', tag:'Celebrate',  img:'🎉' },
      { title:'🎤 Live Band Hire',                  sub:'Afro, reggae, jazz & pop bands for events',       href:'entertainment.html', tag:'Live Music', img:'🎤' },
      { title:'🎬 Video Production & Editing',      sub:'Videographers, editors & drone operators',        href:'entertainment.html', tag:'Create',     img:'🎬' },
      { title:'🎪 Kids Birthday Party Packages',   sub:'Clowns, bouncy castles & party packs from KES 5K', href:'entertainment.html', tag:'Kids Party', img:'🎪' },
      { title:'🎮 Gaming Tournaments & Esports',   sub:'Join or host gaming events near you',              href:'entertainment.html', tag:'Esports',    img:'🎮' },
      { title:'🎸 Music Lessons — All Instruments', sub:'Guitar, piano, voice & drum lessons near you',   href:'services.html',       tag:'Learn Music', img:'🎸' },
      { title:'🎨 Art Workshops & Classes',         sub:'Painting, drawing & pottery for beginners',       href:'entertainment.html', tag:'Create Art', img:'🎨' },
      { title:'🍿 Movie Night Packages',            sub:'Private screening rooms from KES 3,000/hr',       href:'entertainment.html', tag:'Cinema',     img:'🍿' },
      { title:'🎯 Team Building Activities',        sub:'Paint-ball, escape rooms & outdoor challenges',   href:'entertainment.html', tag:'Team Fun',   img:'🎯' },
      { title:'🌄 Safari & Excursion Packages',    sub:'Nairobi NP, Maasai Mara & Amboseli day trips',    href:'entertainment.html', tag:'Adventure',  img:'🌄' },
      { title:'🎠 Carnival & Fun Fair Events',     sub:'Rides, games & street food festivals near you',   href:'entertainment.html', tag:'Family Fun', img:'🎠' },
      { title:'🕺 Dance Classes — All Styles',     sub:'Salsa, afrobeat, Zumba & ballroom near you',       href:'entertainment.html', tag:'Dance',      img:'🕺' },
      { title:'🎰 Casino & Entertainment Night',  sub:'Poker nights, pool tables & entertainment venues', href:'entertainment.html', tag:'Night Out',  img:'🎲' },
      { title:'🎤 Open Mic & Spoken Word Events', sub:'Find poetry nights & open mics in your city',      href:'entertainment.html', tag:'Mic Up',     img:'🎤' },
      { title:'🎻 Wedding Entertainment Package', sub:'DJ, band, MC & decor — all-in wedding packages',   href:'entertainment.html', tag:'Weddings',   img:'💒' },
      { title:'📺 Content Creator Packages',      sub:'Studio hire, lighting & editing services for YouTubers', href:'entertainment.html', tag:'Creator',img:'📺' },
      { title:'🌃 Rooftop Bar & Event Venue Hire', sub:'Premium event spaces with catering in Nairobi',   href:'entertainment.html', tag:'Venue',      img:'🌃' },
    ],
    luxury: [
      { title:'💎 Designer Watches & Jewellery',   sub:'Verified authentic pieces on Sokoni',              href:'category.html?cat=luxury', tag:'Exclusive',   img:'⌚' },
      { title:'👜 Luxury Handbags',                sub:'LV, Gucci, Chanel & more — buyer verified',        href:'category.html?cat=luxury', tag:'Authentic',   img:'👜' },
      { title:'✈️ Premium Travel Packages',        sub:'Safari, beach & international packages',           href:'bnb.html',                 tag:'VIP',         img:'✈️' },
      { title:'🥂 VIP Event Tickets',              sub:'Gala dinners, premieres & exclusive shows',        href:'entertainment.html',       tag:'VIP Only',    img:'🥂' },
      { title:'🏨 Luxury Hotels & Lodges',         sub:'5-star stays across Kenya from USD 120/night',     href:'bnb.html',                 tag:'5-Star',      img:'🏨' },
      { title:'🚁 Helicopter Tours Kenya',         sub:'Scenic aerial tours over Nairobi & the Mara',     href:'entertainment.html',       tag:'Aerial VIP',  img:'🚁' },
      { title:'🍾 Fine Dining Experiences',        sub:'Premium Nairobi restaurants & private chef hire', href:'food.html',                 tag:'Fine Dining', img:'🍾' },
      { title:'🛥️ Yacht & Boat Hire Kenya',       sub:'Lake Victoria & coastal boat cruises',             href:'entertainment.html',       tag:'On Water',    img:'⛵' },
      { title:'💆 VIP Spa Retreats',               sub:'Full-day luxury spa experiences from KES 8,000',  href:'services.html',            tag:'Pamper',      img:'🧖' },
      { title:'🏇 Private Racecourse Events',      sub:'VIP race day experiences at Ngong Racecourse',    href:'entertainment.html',       tag:'Elite',       img:'🏇' },
      { title:'🎰 Executive Clubhouse Access',     sub:'Exclusive membership clubs in Nairobi CBD',       href:'entertainment.html',       tag:'Members Only', img:'🎩' },
      { title:'💍 Custom Diamond Jewellery',       sub:'Bespoke engagement rings & fine jewellery',       href:'category.html?cat=luxury', tag:'Bespoke',     img:'💍' },
      { title:'🏠 Luxury Villa Rentals',           sub:'Gated villa stays in Karen, Muthaiga & Runda',    href:'bnb.html',                 tag:'Villa',       img:'🏡' },
      { title:'🎁 Luxury Gift Boxes & Hampers',   sub:'Curated premium gift sets for executives',         href:'category.html?cat=luxury', tag:'Gift',        img:'🎁' },
      { title:'🌍 Private Jet Charter Kenya',      sub:'Domestic & regional private jet travel',          href:'entertainment.html',       tag:'Private Jet', img:'✈️' },
      { title:'🥃 Rare Whisky & Spirits Collection', sub:'Single malts, aged rum & collector bottles',    href:'category.html?cat=luxury', tag:'Premium Sip', img:'🥃' },
      { title:'🖼️ Original Art & Collectibles',   sub:'Investment-grade Kenyan & African fine art',      href:'category.html?cat=luxury', tag:'Collectible', img:'🖼️' },
      { title:'🌺 Luxury Floral Arrangements',    sub:'Bespoke bouquets & event florals from KES 3,000', href:'services.html',             tag:'Floral',      img:'🌺' },
      { title:'🐴 Equestrian & Horse Riding',     sub:'Riding lessons & trail rides in Nairobi\'s Karen', href:'sports-hub.html',          tag:'Equestrian',  img:'🐴' },
      { title:'📿 Gemstone & Gold Investment',    sub:'Buy gold, diamonds & gems as an investment asset', href:'category.html?cat=luxury', tag:'Invest',      img:'📿' },
    ],
    books: [
      { title:'📚 Top Business Books of 2025',     sub:'Strategy, finance & leadership titles',            href:'category.html?cat=books', tag:'Bestseller', img:'📖' },
      { title:'🎓 Online Courses & Certifications', sub:'Upskill with top Kenya & global trainers',        href:'tech-hub.html',            tag:'Learn Now',  img:'🎓' },
      { title:'📐 School Stationery Bulk Pack',     sub:'Pens, notebooks, geometry sets & more',           href:'category.html?cat=books', tag:'School',     img:'✏️' },
      { title:'👶 Children\'s Books',               sub:'Bilingual Swahili-English picture books',         href:'category.html?cat=books', tag:'Kids',       img:'🌟' },
      { title:'💡 Self-Help & Motivation',          sub:'Books that transform mindset & habits',            href:'category.html?cat=books', tag:'Mindset',    img:'💡' },
      { title:'📜 KCSE & KCPE Past Papers',        sub:'Exam prep with full mark schemes & answers',       href:'tech-hub.html',            tag:'Exam Prep',  img:'📜' },
      { title:'🖥️ Coding Bootcamp — Beginners',   sub:'Python, JavaScript & data science from scratch',   href:'tech-hub.html',            tag:'Code',       img:'💻' },
      { title:'📊 Accounting & Finance Study Kits', sub:'CPA, ACCA & CFA materials — Kenyan suppliers',   href:'category.html?cat=books', tag:'Finance',    img:'📊' },
      { title:'🌍 African Literature Collection',   sub:'Ngugi, Chimamanda, Weep Not Child & classics',   href:'category.html?cat=books', tag:'African Lit', img:'📖' },
      { title:'👔 MBA & Business Management Books', sub:'Top-rated MBA textbooks at student prices',      href:'category.html?cat=books', tag:'MBA',        img:'🎓' },
      { title:'🍳 Cooking & Recipe Books',          sub:'Kenyan cuisine, international & healthy cooking', href:'category.html?cat=books', tag:'Cook It',    img:'🍳' },
      { title:'🌟 Motivational Audio Books',        sub:'Download & listen to bestselling self-help titles', href:'tech-hub.html',           tag:'Listen',     img:'🎧' },
      { title:'🖊️ Journals & Planners',            sub:'Daily planners, goal journals & notebooks from KES 200', href:'category.html?cat=books', tag:'Plan', img:'📓' },
      { title:'🔬 Science & Engineering Textbooks', sub:'STEM textbooks for uni & polytechnic students',  href:'category.html?cat=books', tag:'STEM',       img:'🔬' },
      { title:'🗣️ Language Learning Kits',         sub:'Swahili, French, Chinese & English self-study kits', href:'tech-hub.html',          tag:'Languages',  img:'🗣️' },
      { title:'📱 Digital Skills Masterclass',      sub:'Excel, PowerPoint, Canva & social media for work', href:'tech-hub.html',           tag:'Digital',    img:'📱' },
      { title:'🌈 Parenting & Child Development',  sub:'Books on raising confident, healthy Kenyan kids',  href:'category.html?cat=books', tag:'Parenting',  img:'👶' },
      { title:'⚖️ Law Textbooks & Statutes',        sub:'Kenya law books, constitution & case summaries',  href:'category.html?cat=books', tag:'Law',        img:'⚖️' },
      { title:'🎨 Art & Design Portfolios',         sub:'Illustration, graphic design & architecture books', href:'category.html?cat=books', tag:'Design',   img:'🎨' },
      { title:'🧘 Meditation & Wellness Guides',    sub:'Mindfulness books & journals for mental clarity', href:'category.html?cat=books', tag:'Wellness',   img:'🧘' },
    ],
    agriculture: [
      { title:'🌾 Farm Inputs at Factory Prices',   sub:'Seeds, fertilizers & pesticides in bulk',         href:'category.html?cat=agriculture', tag:'Bulk Buy',  img:'🌾' },
      { title:'🐓 Poultry Supplies & Equipment',    sub:'Chicken coops, feeders & vet supplies',           href:'category.html?cat=agriculture', tag:'Farm',      img:'🐔' },
      { title:'🚜 Farm Equipment Rental',           sub:'Tractors, ploughs & harvesters for hire',         href:'category.html?cat=agriculture', tag:'Hire',      img:'🚜' },
      { title:'💧 Irrigation Systems',              sub:'Drip & sprinkler systems from KES 8K',            href:'category.html?cat=agriculture', tag:'Grow More', img:'💧' },
      { title:'🐄 Livestock & Dairy Supplies',      sub:'Feed, medicine & dairy equipment',                href:'category.html?cat=agriculture', tag:'Livestock', img:'🐄' },
      { title:'🌱 Greenhouse Kits & Supplies',      sub:'Tunnel houses, shade nets & polythene from KES 15K', href:'category.html?cat=agriculture', tag:'Greenhouse', img:'🌱' },
      { title:'🐟 Aquaculture & Fish Farming',      sub:'Fingerlings, feeds & pond liners for fish farmers', href:'category.html?cat=agriculture', tag:'Aquaculture', img:'🐟' },
      { title:'🐝 Beekeeping Starter Kits',         sub:'Hives, suits, extractors & training near you',    href:'category.html?cat=agriculture', tag:'Honey',     img:'🍯' },
      { title:'🌻 Floriculture & Flower Farming',  sub:'Rose seedlings, export flowers & pesticides',      href:'category.html?cat=agriculture', tag:'Flowers',   img:'🌻' },
      { title:'🥬 Vegetable Seedlings & Saplings', sub:'Kale, tomato, capsicum & tree seedlings',           href:'category.html?cat=agriculture', tag:'Seedlings', img:'🥬' },
      { title:'🧪 Soil Testing Services',           sub:'Lab soil analysis to maximise crop yield',        href:'category.html?cat=agriculture', tag:'Soil Test', img:'🧪' },
      { title:'☀️ Solar Irrigation Pumps',          sub:'Off-grid solar water pumps for remote farms',     href:'category.html?cat=agriculture', tag:'Solar',     img:'☀️' },
      { title:'🌽 Grain Storage & Silos',           sub:'Hermetic bags, metallic silos & driers',         href:'category.html?cat=agriculture', tag:'Post-Harvest', img:'🌽' },
      { title:'🐐 Goat & Sheep Farming Supplies',  sub:'Dips, feeds, ear tags & housing materials',        href:'category.html?cat=agriculture', tag:'Livestock', img:'🐐' },
      { title:'🚛 Agri-Produce Transport',          sub:'Refrigerated trucks & produce logistics near you', href:'delivery.html',                 tag:'Cold Chain', img:'🚛' },
      { title:'📱 Digital Farming Apps & Tools',   sub:'Apps for crop management, weather & market prices', href:'tech-hub.html',                  tag:'AgriTech', img:'📱' },
      { title:'🌍 Export Market Access',            sub:'Register your farm produce for EU & Gulf exports', href:'services.html',                 tag:'Export',   img:'🌍' },
      { title:'🔬 Crop Disease Diagnosis',          sub:'Plant pathology experts & quick test kits',       href:'category.html?cat=agriculture', tag:'Crop Health', img:'🔬' },
      { title:'🧑‍🌾 Agricultural Training & Workshops', sub:'County & NGO farming trainings near you',    href:'community.html',                tag:'Training', img:'🎓' },
      { title:'💰 Agri-Finance & Crop Insurance',  sub:'KCIC, Equity & KCB farm loans & insurance',       href:'banking.html',                  tag:'Finance',  img:'💰' },
    ],
    construction: [
      { title:'🏗️ Building Materials Wholesale',   sub:'Cement, iron sheets, timber — bulk prices',       href:'construction.html', tag:'Bulk',       img:'🧱' },
      { title:'👷 Contractors & Engineers',         sub:'Find certified builders, architects & surveyors', href:'construction.html', tag:'Hire Pro',   img:'👷' },
      { title:'🪟 Doors, Windows & Roofing',       sub:'Aluminium, wooden & UPVC — factory direct',        href:'construction.html', tag:'Build',      img:'🪟' },
      { title:'🔌 Electrical & Plumbing Supply',   sub:'Wires, pipes, fittings & installation kits',       href:'construction.html', tag:'Install',    img:'🔌' },
      { title:'🧱 Stone & Sand Delivery Nairobi',  sub:'Machine-cut stones, ballast, sand — bulk order',   href:'construction.html', tag:'Foundation', img:'🏗️' },
      { title:'🏠 House Plans & Architecture',     sub:'Affordable certified house designs from KES 5,000', href:'construction.html', tag:'Design',     img:'🏠' },
      { title:'🪚 Timber & Carpentry Supplies',   sub:'Hardwood, softwood & pre-cut timber from mills',   href:'construction.html', tag:'Wood',       img:'🪚' },
      { title:'🔩 Hardware Store — All Fittings',  sub:'Nails, bolts, hinges, locks & plumbing fittings', href:'construction.html', tag:'Hardware',   img:'🔩' },
      { title:'🎨 Paint & Coating Deals',          sub:'Crown, Basco, Sadolin — interior & exterior',      href:'construction.html', tag:'Paint',      img:'🎨' },
      { title:'🪵 Steel & Metal Fabrication',      sub:'Structural steel, roofing trusses & fabricators', href:'construction.html', tag:'Steel',      img:'🏗️' },
      { title:'🛖 Prefab & Container Homes',       sub:'Affordable prefabricated houses from KES 800K',   href:'construction.html', tag:'Prefab',     img:'🛖' },
      { title:'🚰 Plumbing Systems & Water Tanks', sub:'HDPE pipes, valves, tanks & pump installation',    href:'construction.html', tag:'Plumbing',   img:'🚰' },
      { title:'🔆 Solar Panel Installation',       sub:'Residential solar systems — supply & fit from KES 60K', href:'electrical.html', tag:'Solar',   img:'☀️' },
      { title:'🏗️ Scaffolding & Equipment Hire',  sub:'Scaffolding, concrete mixers & vibrators for rent', href:'construction.html', tag:'Equipment', img:'🔩' },
      { title:'🧰 Construction Tools for Sale',    sub:'Power drills, angle grinders, levels & more',     href:'construction.html', tag:'Tools',      img:'🧰' },
      { title:'🪟 Aluminium Fabrication Services', sub:'Curtain walls, shopfronts & custom windows',       href:'construction.html', tag:'Fabrication', img:'🔨' },
      { title:'🏘️ Plot Levelling & Earthworks',  sub:'Excavation, grading & site preparation services',   href:'construction.html', tag:'Earthworks', img:'🚜' },
      { title:'🔐 Security Systems Installation',  sub:'CCTV, electric fence & alarm system fitting',     href:'construction.html', tag:'Security',   img:'📹' },
      { title:'🌿 Landscaping & Garden Design',   sub:'Grass, paving, irrigation & outdoor design',       href:'services.html',     tag:'Garden',     img:'🌿' },
      { title:'💡 Interior Design Consultations',  sub:'Affordable interior designers in Nairobi & Mombasa', href:'services.html',  tag:'Design',     img:'🖌️' },
    ],
    property: [
      { title:'🏘️ Affordable Housing in Nairobi', sub:'Apartments & townhouses from KES 2.5M',           href:'property.html', tag:'Hot Listing', img:'🏘️' },
      { title:'🏢 Commercial Space for Rent',      sub:'Office, retail & warehouse — CBD & outskirts',    href:'property.html', tag:'Business',    img:'🏢' },
      { title:'🌳 Land for Sale Kenya-wide',       sub:'Agricultural, residential & commercial plots',    href:'property.html', tag:'Invest',      img:'🌳' },
      { title:'🏨 BnB & Short-Term Stays',         sub:'Furnished apartments from KES 2,500/night',      href:'bnb.html',      tag:'Stay',        img:'🏨' },
      { title:'🏠 1-Bedroom Apartments in Westlands', sub:'Modern flats from KES 35K/month — move-in ready', href:'property.html', tag:'Rent Now', img:'🏠' },
      { title:'🏰 Maisonettes & Villas for Sale',  sub:'Gated community homes in Karen & Kiambu',        href:'property.html', tag:'Premium',    img:'🏰' },
      { title:'🌍 Diaspora Property Investment',   sub:'Buy & manage Kenya property from abroad',         href:'property.html', tag:'Diaspora',   img:'✈️' },
      { title:'🏗️ Off-Plan Projects — Early Bird',sub:'Buy before completion & save up to 20%',          href:'property.html', tag:'Off-Plan',   img:'🏗️' },
      { title:'📐 Survey & Title Deed Services',   sub:'Licensed surveyors for land searches & registration', href:'legal-hub.html', tag:'Legal',  img:'📜' },
      { title:'🔑 Property Management Services',   sub:'Full tenant management for landlords — stress-free', href:'landlord.html', tag:'Managed', img:'🔑' },
      { title:'🏙️ Mombasa Beach Property Deals',  sub:'Seafront apartments & plots at the coast',        href:'property.html', tag:'Coastal',   img:'🌊' },
      { title:'🏡 Kiambu & Ruiru Townhouses',      sub:'Gated townhouses from KES 5M — low deposit',     href:'property.html', tag:'Suburban',  img:'🏡' },
      { title:'💼 Commercial & Industrial Plots',  sub:'EPZA, industrial zone & warehouse plots for sale', href:'property.html', tag:'Industrial', img:'🏭' },
      { title:'🤝 Real Estate Agent Network',      sub:'Find verified, accredited property agents on Sokoni', href:'property.html', tag:'Agent',  img:'🤝' },
      { title:'💰 Mortgage Calculator & Advisors', sub:'HF, KCB & equity mortgages compared & explained', href:'banking.html',  tag:'Mortgage',  img:'💰' },
      { title:'🌲 Eldoret & Nakuru Investment Plots', sub:'Sub-divided plots from KES 150K in growing towns', href:'property.html', tag:'Upcountry', img:'🌲' },
      { title:'📱 Virtual Property Tours',         sub:'360° property walkthroughs before you visit',     href:'property.html', tag:'Virtual',   img:'📱' },
      { title:'🏘️ Social Housing Projects',       sub:'Government-affiliated affordable housing near you', href:'property.html', tag:'Affordable', img:'🏠' },
      { title:'🔓 Rental Deposit Schemes',         sub:'Move in with just 1 month deposit — partner agents', href:'property.html', tag:'Easy Move', img:'🗝️' },
      { title:'🌅 Holiday Homes for Rent',         sub:'Beach cottages, villas & lodges for getaways',   href:'bnb.html',      tag:'Holiday',   img:'🌅' },
    ],
    travel: [
      { title:'🌍 Maasai Mara Safari Packages',    sub:'3-7 night game drives from KES 25,000',           href:'entertainment.html', tag:'Safari',     img:'🦁' },
      { title:'✈️ Domestic Flights — Best Fares',  sub:'Nairobi–Mombasa, Kisumu & Eldoret from KES 3K',  href:'entertainment.html', tag:'Fly Kenya',  img:'✈️' },
      { title:'🏖️ Mombasa Beach Getaways',         sub:'3-night hotel + transfer packages from KES 15K', href:'bnb.html',           tag:'Beach',      img:'🏖️' },
      { title:'🗺️ Tour Packages — East Africa',   sub:'Uganda, Tanzania, Rwanda & Ethiopia packages',    href:'entertainment.html', tag:'Explore',    img:'🌍' },
      { title:'🎒 Backpacker Travel Deals',         sub:'Budget hostels, tours & transport across East Africa', href:'bnb.html',      tag:'Budget',     img:'🎒' },
      { title:'🦒 Nairobi National Park Day Trip', sub:'Half-day game drive from KES 5,000 pp',           href:'entertainment.html', tag:'Day Trip',   img:'🦒' },
      { title:'🏔️ Mount Kenya Hiking Tours',       sub:'2-5 day guided climbs with gear included',        href:'sports-hub.html',    tag:'Hiking',     img:'🏔️' },
      { title:'🚢 Lamu & Zanzibar Dhow Trips',     sub:'Coastal luxury sailing holidays from KES 30K',   href:'bnb.html',           tag:'Sailing',    img:'⛵' },
      { title:'🌋 Turkana & Rift Valley Expeditions', sub:'Remote Kenya adventure tours',                href:'entertainment.html', tag:'Adventure',  img:'🌋' },
      { title:'🏨 Hotel Deals — Last Minute',      sub:'4 & 5 star last-minute deals from KES 4,000/night', href:'bnb.html',        tag:'Last Minute', img:'🏨' },
      { title:'🚌 Intercity Bus & Train Tickets',  sub:'Kampala, Dar, Mombasa & Kisumu from Nairobi',    href:'entertainment.html', tag:'Travel',     img:'🚌' },
      { title:'📸 Photography Tours Nairobi',      sub:'Sunrise photo safaris, street & wildlife sessions', href:'entertainment.html', tag:'Photo',    img:'📸' },
      { title:'🌊 Watamu & Diani Marine Park',     sub:'Snorkelling, diving & boat safaris on the coast', href:'entertainment.html', tag:'Marine',    img:'🌊' },
      { title:'🎋 Cultural Village Experiences',   sub:'Maasai, Samburu & Kikuyu cultural immersions',   href:'entertainment.html', tag:'Culture',    img:'🎋' },
      { title:'🏕️ Camping & Glamping Sites',       sub:'Luxury tented camps & camping sites across Kenya', href:'bnb.html',         tag:'Camp',       img:'⛺' },
    ],
    baby: [
      { title:'🍼 Baby Formula & Food Deals',      sub:'NAN, Similac, Aptamil & local brands on sale',   href:'category.html?cat=baby', tag:'Nutrition',  img:'🍼' },
      { title:'🛒 Stroller & Pram Sale',           sub:'Lightweight & travel strollers from KES 5,000',  href:'category.html?cat=baby', tag:'Pram Sale',  img:'🛒' },
      { title:'👶 Newborn Essentials Kit',         sub:'Nappies, wipes, bodysuits & blanket sets',       href:'category.html?cat=baby', tag:'New Baby',   img:'🧸' },
      { title:'🎈 Baby Shower Gift Sets',          sub:'Curated gift boxes for new mums from KES 2,500', href:'category.html?cat=baby', tag:'Gift',       img:'🎁' },
      { title:'🪀 Educational Toys for Toddlers',  sub:'STEM, sensory & creative toys for 0–5 years',   href:'category.html?cat=baby', tag:'Toys',       img:'🪀' },
      { title:'🛏️ Baby Cots & Crib Sets',          sub:'Moses baskets, cots & co-sleepers from KES 4K', href:'category.html?cat=baby', tag:'Sleep',      img:'🛏️' },
      { title:'🩺 Paediatric Doctor Consultations', sub:'Child health check-ups & immunisations near you', href:'healthcare.html',      tag:'Child Health', img:'👶' },
      { title:'🎠 Nursery & Pre-School Furniture',  sub:'Play tables, storage & decor for kids rooms',   href:'category.html?cat=baby', tag:'Nursery',   img:'🎠' },
      { title:'🧶 Knitted Baby Clothing',           sub:'Handmade & machine-knit beanies, booties & sets', href:'category.html?cat=baby', tag:'Handmade', img:'🧶' },
      { title:'🏥 Baby Monitor & Safety Gear',     sub:'Video monitors, baby gates & corner protectors', href:'category.html?cat=baby', tag:'Safety',    img:'📹' },
    ],
    pets: [
      { title:'🐕 Dog Food — Premium Brands',      sub:'Royal Canin, Pedigree & Hills from KES 800',      href:'category.html?cat=pets', tag:'Dog Nutrition', img:'🐕' },
      { title:'🐈 Cat Supplies & Accessories',      sub:'Litter, food, toys & carriers for your cat',      href:'category.html?cat=pets', tag:'Cat Lover',   img:'🐈' },
      { title:'🩺 Vet Services Near You',           sub:'Vaccinations, checkups & pet surgery in Nairobi', href:'services.html',          tag:'Vet',         img:'🩺' },
      { title:'🐾 Pet Grooming Salons',             sub:'Bathing, trimming & nail clipping for dogs & cats', href:'services.html',        tag:'Grooming',    img:'✂️' },
      { title:'🐠 Aquarium Fish & Supplies',        sub:'Tropical fish, tanks, filters & fish food',       href:'category.html?cat=pets', tag:'Aquarium',    img:'🐠' },
      { title:'🦜 Birds & Aviary Supplies',         sub:'Parrots, budgies, cages & bird feed',             href:'category.html?cat=pets', tag:'Birds',       img:'🦜' },
      { title:'🏠 Pet Kennels & Boarding',          sub:'Trusted kennels & pet hotels while you travel',   href:'services.html',          tag:'Pet Care',    img:'🏠' },
      { title:'💊 Pet Medication & Vitamins',       sub:'Dewormers, flea treatments & supplements',        href:'category.html?cat=pets', tag:'Pet Health',  img:'💊' },
      { title:'🎾 Pet Toys & Enrichment',           sub:'Chew toys, puzzle feeders & interactive games',   href:'category.html?cat=pets', tag:'Play Time',   img:'🎾' },
      { title:'🐕‍🦺 Dog Training Services',          sub:'Professional dog obedience & behaviour training', href:'services.html',          tag:'Training',    img:'🐕‍🦺' },
    ],
    finance: [
      { title:'💰 Business Loans — Fast Approval',  sub:'KCB, Equity, NCBA & digital lenders compared',  href:'banking.html', tag:'Finance',    img:'🏦' },
      { title:'📈 Stock Market Investing in Kenya',  sub:'NSE shares — how to start investing from KES 100', href:'banking.html', tag:'Invest',   img:'📈' },
      { title:'💳 Mobile Money & Paybill Setup',    sub:'Set up M-Pesa Paybill, Till & Lipa na Mpesa',    href:'banking.html', tag:'M-Pesa',    img:'📱' },
      { title:'🛡️ Life & Health Insurance Deals',   sub:'Compare affordable insurance plans on Sokoni',   href:'banking.html', tag:'Insure',    img:'🛡️' },
      { title:'🏦 Bank Account Opening Offers',     sub:'Open a current/savings account — bonus rates',    href:'banking.html', tag:'Banking',   img:'🏦' },
      { title:'💵 Forex & Currency Exchange',       sub:'Best exchange rates in Nairobi — USD, GBP, EUR', href:'banking.html', tag:'Forex',     img:'💵' },
      { title:'🤑 Chama & SACCO Investment Tools', sub:'Group savings, loans & investment platforms',      href:'banking.html', tag:'SACCO',     img:'🤝' },
      { title:'📊 Financial Planning Services',     sub:'Certified financial planners & budgeting coaches', href:'banking.html', tag:'Plan',     img:'📊' },
      { title:'🎓 Scholarships & Student Loans',    sub:'HELB loans, bursaries & scholarship databases',  href:'banking.html', tag:'Education', img:'🎓' },
      { title:'🏠 Home Mortgage Advisors',          sub:'Housing Finance, KCB & Stanbic mortgage options', href:'banking.html', tag:'Mortgage',  img:'🏠' },
    ],
  };

  /* ─── STORAGE ─── */
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  }
  function save(d) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); } catch {}
  }

  /* ─── TRACK INTEREST ─── */
  function track(cat, weight) {
    if (!CATS[cat]) return;
    const d = load();
    if (!d.scores) d.scores = {};
    d.scores[cat] = (d.scores[cat] || 0) + (weight || 1);
    d.lastSeen = Date.now();
    save(d);
  }

  /* ─── AUTO-TRACK FROM CURRENT PAGE ─── */
  function autoTrack() {
    const page   = (window.location.pathname.split('/').pop() || 'index.html').split('?')[0];
    const params = new URLSearchParams(window.location.search);
    const cat    = params.get('cat') || '';
    const q      = (params.get('q') || '').toLowerCase();

    const pageMap = {
      'food.html':'food', 'healthcare.html':'healthcare', 'sports-hub.html':'sports',
      'entertainment.html':'entertainment', 'car-hub.html':'automotive', 'car-rental.html':'automotive',
      'mechanics.html':'automotive', 'construction.html':'construction', 'property.html':'property',
      'landlord.html':'property', 'bnb.html':'travel', 'digital.html':'books',
      'legal-hub.html':'books', 'community.html':'entertainment', 'banking.html':'finance',
      'driver.html':'automotive', 'electrical.html':'construction', 'plumbing.html':'construction',
    };
    if (pageMap[page]) track(pageMap[page], 3);

    const catMap = {
      food:'food', electronics:'electronics', fashion:'fashion', beauty:'beauty',
      furniture:'furniture', sports:'sports', cars:'automotive', health:'healthcare',
      books:'books', agriculture:'agriculture', luxury:'luxury', accessories:'fashion',
      appliances:'furniture', baby:'baby', kids:'baby', pets:'pets', finance:'finance',
      travel:'travel', property:'property',
    };
    if (cat && catMap[cat]) track(catMap[cat], 2);

    /* The wishlist interest signal is removed rather than repointed.
       It read localStorage['sokoniWishlist'], a key with ZERO writers anywhere in the
       repo — so `wl` was always [] and this loop has never contributed a single point.
       Rerouting it to the canonical wishlist would not change that: wishlistItems stores
       uid/productId/shopId/name/price/image/addedAt and carries NO category, so
       catMap[p.category] would be undefined for every record. Wiring it up would look
       like a migration while still scoring nothing.
       If wishlist-driven personalisation is wanted, `category` has to be added to the
       canonical record deliberately — a schema decision, not a side effect of this
       cleanup. Until then this signal does not exist, and says so. */

    try {
      const cart = JSON.parse(localStorage.getItem('sokoniCart') || '[]');
      cart.forEach(p => { if (p.category && catMap[p.category]) track(catMap[p.category], 2); });
    } catch {}

    if (q) {
      const kw = {
        food:          /food|pizza|rice|chicken|ugali|chapati|mandazi|restaurant|grocery|sukuma|nyama|chai|mkate|pilau|biriani/,
        electronics:   /phone|laptop|tablet|gadget|smart|tech|camera|earphone|charger|screen|iphone|samsung|tecno|tv|router/,
        fashion:       /dress|shoes|trouser|shirt|fashion|cloth|skirt|suit|blazer|jeans|hoodie|sneaker|boot|wear/,
        beauty:        /skincare|makeup|lipstick|cream|perfume|lotion|serum|moisturi|foundation|nail|shampoo|hair/,
        furniture:     /sofa|bed|table|chair|decor|kitchen|furniture|mattress|wardrobe|shelf|curtain|lamp/,
        sports:        /ball|gym|football|running|sports|boot|jersey|fitness|training|yoga|cycling|tennis/,
        automotive:    /car|tyre|engine|mechanic|auto|vehicle|motorbike|boda|truck|fuel|petrol|battery/,
        healthcare:    /doctor|hospital|medicine|clinic|nurse|pharmacy|lab|test|health|dental|therapy|vaccine/,
        entertainment: /dj|event|party|concert|show|comedy|photographer|band|wedding|celebrate|music/,
        luxury:        /luxury|designer|gucci|louis|lv|rolex|champagne|vip|exclusive|premium|watch/,
        books:         /book|course|study|learn|school|education|stationery|pencil|notebook|exam/,
        agriculture:   /farm|seed|fertilizer|livestock|poultry|tractor|irrigation|crop|soil|cattle|milk/,
        construction:  /cement|build|brick|timber|roofing|contractor|architect|plumb|electrical|door|window|paint/,
        property:      /house|land|apartment|rent|lease|property|plot|estate|tenant|landlord|bedsitter/,
        travel:        /safari|travel|tour|hotel|flight|beach|mombasa|mara|kampala|zanzibar|holiday/,
        baby:          /baby|infant|toddler|nappy|pram|formula|stroller|nursery|newborn/,
        pets:          /dog|cat|pet|vet|puppy|kitten|fish|bird|aquarium|kennel/,
        finance:       /loan|bank|invest|mpesa|insurance|mortgage|sacco|forex|stock|shares/,
      };
      Object.entries(kw).forEach(([key, rx]) => { if (rx.test(q)) track(key, 2); });
    }

    try {
      const orders = JSON.parse(localStorage.getItem('sokoniOrders') || '[]');
      orders.slice(0, 5).forEach(o => {
        (o.items || []).forEach(p => { if (p.category && catMap[p.category]) track(catMap[p.category], 3); });
      });
    } catch {}
  }

  /* ─── QUERY HELPERS ─── */
  function getTopCategories(n) {
    const d = load();
    return Object.entries(d.scores || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, n || 5)
      .map(([key, score]) => ({ key, score, ...(CATS[key] || {}) }));
  }

  function getPersona() {
    const top = getTopCategories(3).map(c => c.key);
    if (!top.length) return null;
    for (const [, p] of Object.entries(PERSONAS)) {
      if (p.cats.some(c => top.includes(c))) return p;
    }
    return null;
  }

  function hasInterests() {
    const d = load();
    return Object.keys(d.scores || {}).length > 0;
  }

  /* ─── INFINITE FEED ENGINE ─── */
  let _buffer = [];    // shuffled card buffer
  let _shown  = null;  // Set of titles shown this session

  function _getShown() {
    if (_shown) return _shown;
    try {
      _shown = new Set(JSON.parse(sessionStorage.getItem(SHOWN_KEY) || '[]'));
    } catch { _shown = new Set(); }
    return _shown;
  }

  function _saveShown() {
    try {
      sessionStorage.setItem(SHOWN_KEY, JSON.stringify([..._getShown()].slice(-400)));
    } catch {}
  }

  function _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function _buildBuffer() {
    const d       = load();
    const scores  = d.scores || {};
    const maxScore = Math.max(...Object.values(scores), 1);
    const allCats  = Object.keys(POOL);

    const weighted = [];
    allCats.forEach(cat => {
      const score   = scores[cat] || 0;
      // Top interests: 4 copies; secondary: 2 copies; discovery (0 score): 1 copy
      const copies  = score > 0 ? Math.ceil((score / maxScore) * 4) + 1 : 1;
      (POOL[cat] || []).forEach(card => {
        for (let i = 0; i < copies; i++) {
          weighted.push({ ...card, catKey: cat, catInfo: CATS[cat], score });
        }
      });
    });

    return _shuffle(weighted);
  }

  function _nextBatch(size) {
    const shown  = _getShown();
    const batch  = [];
    const adding = new Set();

    while (batch.length < size) {
      if (!_buffer.length) {
        _buffer = _buildBuffer();
        // After exhausting pool, allow showing previously-seen cards again
        shown.clear();
      }

      const card = _buffer.shift();
      if (!card) break;
      if (!shown.has(card.title) && !adding.has(card.title)) {
        batch.push(card);
        shown.add(card.title);
        adding.add(card.title);
      }
    }

    _saveShown();
    return batch;
  }

  /* ─── RENDER HELPERS ─── */
  function hexRgb(h) {
    const r = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
    return r ? `${parseInt(r[1],16)},${parseInt(r[2],16)},${parseInt(r[3],16)}` : '113,255,0';
  }

  function _cardHTML(c) {
    const col = c.catInfo?.color || '#71ff00';
    const rgb = hexRgb(col);
    return `<a href="${c.href}" class="inspiq-card" style="--iq-col:${col};--iq-rgb:${rgb};" onclick="InspIQ.trackClick('${c.catKey || ''}')">
      <div class="inspiq-img">${c.img}</div>
      <span class="inspiq-tag" style="color:${col};background:${col}1a;border-color:${col}40;">${c.tag}</span>
      <div class="inspiq-title">${c.title}</div>
      <div class="inspiq-sub">${c.sub}</div>
      <div class="inspiq-foot">
        <span>${c.catInfo?.emoji || '📌'} ${c.catInfo?.label || ''}</span>
        <span style="color:${col};">→</span>
      </div>
    </a>`;
  }

  /* ─── INFINITE SCROLL RENDER ─── */
  let _observer   = null;
  let _sentinel   = null;
  let _feedEl     = null;
  let _loading    = false;
  let _feedActive = false;

  function _appendCards(cards) {
    if (!_feedEl || !cards.length) return;
    const frag = document.createDocumentFragment();
    cards.forEach(c => {
      const div = document.createElement('div');
      div.innerHTML = _cardHTML(c);
      frag.appendChild(div.firstChild);
    });
    // Insert before sentinel
    if (_sentinel && _sentinel.parentNode === _feedEl) {
      _feedEl.insertBefore(frag, _sentinel);
    } else {
      _feedEl.appendChild(frag);
    }
  }

  function _loadMore() {
    if (_loading) return;
    _loading = true;
    const batch = _nextBatch(PAGE_SIZE);
    _appendCards(batch);
    _loading = false;
  }

  function renderForYou(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    _feedEl     = el;
    _feedActive = true;

    // Clear & seed
    el.innerHTML = '';
    _buffer = _buildBuffer();

    const initial = _nextBatch(PAGE_SIZE);
    if (!initial.length) {
      const s = el.closest && el.closest('section');
      if (s) s.style.display = 'none';
      return;
    }
    _appendCards(initial);

    // Create sentinel for infinite scroll
    _sentinel = document.createElement('div');
    _sentinel.id = 'inspiqSentinel';
    _sentinel.style.cssText = 'height:1px;width:100%;';
    el.appendChild(_sentinel);

    // IntersectionObserver — load more when sentinel enters view
    if (_observer) _observer.disconnect();
    _observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) _loadMore();
    }, { rootMargin: '300px' });
    _observer.observe(_sentinel);

    // Scroll fallback for environments where IntersectionObserver lags
    window.addEventListener('scroll', function _iqScroll() {
      if (!_sentinel) { window.removeEventListener('scroll', _iqScroll); return; }
      const rect = _sentinel.getBoundingClientRect();
      if (rect.top < window.innerHeight + 400) _loadMore();
    }, { passive: true });
  }

  function generateCards(count) {
    return _nextBatch(count || PAGE_SIZE);
  }

  /* ─── INTEREST PICKER (onboarding) ─── */
  function renderPicker(containerId) {
    const el = document.getElementById(containerId);
    if (!el || hasInterests()) { if (el) el.innerHTML = ''; return; }
    el.innerHTML = `
      <div style="padding:16px 0 8px;text-align:center;">
        <div style="font-size:13px;font-weight:800;color:rgba(255,255,255,0.7);margin-bottom:4px;">✨ Pick what you love</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:14px;">We'll show you an unlimited feed of deals & content you'll actually want</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:500px;margin:0 auto;">
          ${Object.entries(CATS).map(([key, c]) => `
            <button type="button" class="iq-pick-btn" data-cat="${key}"
              style="display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:999px;border:1px solid ${c.color}30;background:${c.color}10;color:rgba(255,255,255,0.55);font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s;"
              onclick="InspIQ.pickInterest('${key}', this)">
              ${c.emoji} ${c.label}
            </button>`).join('')}
        </div>
        <button type="button" onclick="InspIQ.applyPick()" style="margin-top:14px;padding:10px 24px;background:linear-gradient(135deg,#71ff00,#4fc800);color:#070707;font-weight:900;border:none;border-radius:10px;cursor:pointer;font-family:inherit;font-size:13px;">Show My Feed →</button>
      </div>`;
  }

  const _picked = new Set();
  function pickInterest(cat, btn) {
    if (_picked.has(cat)) {
      _picked.delete(cat);
      btn.style.background   = (CATS[cat]?.color || '#71ff00') + '10';
      btn.style.color        = 'rgba(255,255,255,0.55)';
      btn.style.borderColor  = (CATS[cat]?.color || '#71ff00') + '30';
      btn.style.transform    = '';
    } else {
      _picked.add(cat);
      const col = CATS[cat]?.color || '#71ff00';
      btn.style.background  = col + '25';
      btn.style.color       = col;
      btn.style.borderColor = col + '60';
      btn.style.transform   = 'scale(1.05)';
    }
  }

  function applyPick() {
    _picked.forEach(cat => track(cat, 5));
    const picker = document.getElementById('inspiqPicker');
    if (picker) picker.style.display = 'none';
    renderForYou('inspiqFeed');
    const section = document.getElementById('inspiqSection');
    if (section) section.style.display = '';
  }

  /* ─── EDIT INTERESTS (for existing users) ─── */
  function renderPickerEdit(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const currentScores = load().scores || {};
    // Pre-populate _picked with categories the user already has scores for
    _picked.clear();
    Object.keys(currentScores).forEach(cat => { if (currentScores[cat] > 0) _picked.add(cat); });

    el.innerHTML = `
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(113,255,0,0.12);border-radius:18px;padding:20px 16px 16px;margin:0 0 12px;">
        <div style="font-size:14px;font-weight:900;color:white;margin-bottom:4px;">✨ Edit Your Interests</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-bottom:16px;">Tap to toggle — your feed updates instantly</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
          ${Object.entries(CATS).map(([key, c]) => {
            const active = _picked.has(key);
            const col = c.color || '#71ff00';
            const bg  = active ? col + '25' : col + '10';
            const fc  = active ? col : 'rgba(255,255,255,0.5)';
            const bc  = active ? col + '60' : col + '28';
            const sc  = active ? 'scale(1.05)' : '';
            return `<button type="button" class="iq-pick-btn" data-cat="${key}"
              style="display:flex;align-items:center;gap:6px;padding:9px 15px;border-radius:999px;border:1px solid ${bc};background:${bg};color:${fc};font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s;transform:${sc};"
              onclick="InspIQ.pickInterest('${key}', this)">
              ${c.emoji} ${c.label}
            </button>`;
          }).join('')}
        </div>
        <button type="button" onclick="InspIQ.applyPickEdit()" style="width:100%;padding:12px;background:linear-gradient(135deg,#71ff00,#4fc800);color:#070707;font-weight:900;border:none;border-radius:12px;cursor:pointer;font-family:inherit;font-size:13px;letter-spacing:.01em;">Update My Feed →</button>
      </div>`;
  }

  function applyPickEdit() {
    const d = load();
    // Reset all scores to 0, then boost selected ones
    const scores = d.scores || {};
    Object.keys(scores).forEach(cat => { scores[cat] = 0; });
    d.scores = scores;
    save(d);
    _picked.forEach(cat => track(cat, 5));
    _picked.clear();
    const picker = document.getElementById('inspiqPicker');
    if (picker) picker.style.display = 'none';
    renderForYou('inspiqFeed');
  }

  function trackClick(cat) {
    if (cat) track(cat, 2);
  }

  /* ─── IN-APP NOTIFICATION TOAST ─── */
  function showNotif() {
    if (sessionStorage.getItem(SESSION_KEY)) return;
    const top = getTopCategories(1)[0];
    if (!top) return;
    sessionStorage.setItem(SESSION_KEY, '1');
    const persona   = getPersona();
    const firstCard = (POOL[top.key] || [])[0];
    if (!firstCard) return;
    const notif = document.createElement('div');
    notif.id = 'inspiqNotifToast';
    const col = top.color || '#71ff00';
    notif.style.cssText = `
      position:fixed;bottom:76px;left:50%;transform:translateX(-50%) translateY(120px);
      background:linear-gradient(145deg,rgba(12,12,12,0.98),rgba(20,20,20,0.98));
      border:1px solid ${col}35;border-radius:18px;padding:14px 16px;
      max-width:340px;width:calc(100% - 32px);z-index:99997;
      box-shadow:0 12px 40px rgba(0,0,0,0.6),0 0 0 1px ${col}15,0 4px 16px ${col}15;
      display:flex;align-items:center;gap:12px;
      transition:transform .45s cubic-bezier(0.34,1.4,0.64,1),opacity .4s ease;
      opacity:0;cursor:pointer;backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);`;
    notif.innerHTML = `
      <div style="font-size:32px;flex-shrink:0;line-height:1;">${top.emoji}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:900;color:white;margin-bottom:3px;">🔥 ${top.label} Alert!</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.45);line-height:1.45;">${persona ? `Because you're a <strong style="color:${col};">${persona.emoji} ${persona.name}</strong> — ` : ''}${firstCard.sub}</div>
      </div>
      <a href="${firstCard.href}" style="flex-shrink:0;padding:8px 12px;background:${col};color:#000;font-weight:900;font-size:10px;border-radius:9px;text-decoration:none;white-space:nowrap;transition:filter .2s;" onmouseover="this.style.filter='brightness(1.1)'" onmouseout="this.style.filter=''">View →</a>
      <button type="button" onclick="this.closest('#inspiqNotifToast').remove()" style="flex-shrink:0;background:none;border:none;color:rgba(255,255,255,0.3);font-size:16px;cursor:pointer;padding:0;line-height:1;">✕</button>`;
    document.body.appendChild(notif);
    setTimeout(() => { notif.style.transform = 'translateX(-50%) translateY(0)'; notif.style.opacity = '1'; }, 2500);
    setTimeout(() => { notif.style.opacity = '0'; notif.style.transform = 'translateX(-50%) translateY(20px)'; }, 9000);
    setTimeout(() => notif.remove(), 9600);
  }

  /* ─── STYLES ─── */
  function _injectStyles() {
    if (document.getElementById('inspiqStyles')) return;
    const st = document.createElement('style');
    st.id = 'inspiqStyles';
    st.textContent = `
      #inspiqFeed{
        display:grid;
        grid-template-columns:repeat(auto-fill,minmax(155px,1fr));
        gap:12px;
        padding:0 28px 40px;
      }
      .inspiq-card{
        display:flex;flex-direction:column;
        background:rgba(255,255,255,0.028);
        border:1px solid rgba(var(--iq-rgb,113,255,0),.18);
        border-radius:16px;padding:14px;text-decoration:none;
        transition:transform .2s,border-color .2s,box-shadow .2s;
        position:relative;overflow:hidden;
        break-inside:avoid;
      }
      .inspiq-card::before{
        content:'';position:absolute;inset:0;
        background:radial-gradient(circle at 25% 20%,rgba(var(--iq-rgb,113,255,0),.07),transparent 65%);
        pointer-events:none;
      }
      .inspiq-card:hover{
        transform:translateY(-4px);
        border-color:rgba(var(--iq-rgb,113,255,0),.38);
        box-shadow:0 8px 24px rgba(var(--iq-rgb,113,255,0),.12);
      }
      .inspiq-img{font-size:32px;text-align:center;margin-bottom:10px;line-height:1;}
      .inspiq-tag{
        display:inline-block;font-size:9px;font-weight:800;
        padding:2px 8px;border-radius:999px;border:1px solid;
        margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em;
        align-self:flex-start;white-space:nowrap;
      }
      .inspiq-title{font-size:11.5px;font-weight:800;color:white;line-height:1.35;margin-bottom:5px;flex-shrink:0;}
      .inspiq-sub{font-size:9.5px;color:rgba(255,255,255,0.38);line-height:1.45;flex:1;}
      .inspiq-foot{margin-top:10px;display:flex;align-items:center;justify-content:space-between;font-size:9px;color:rgba(255,255,255,0.3);font-weight:700;}
      .iq-pick-btn:hover{transform:scale(1.06) !important;}
      @media(max-width:480px){
        #inspiqFeed{grid-template-columns:repeat(2,1fr);padding:0 12px 40px;gap:10px;}
      }
    `;
    document.head.appendChild(st);
  }

  /* ─── HOME FEED — 10 cards, rotating ─── */
  const HOME_LIMIT    = 10;
  const HOME_ROTATE_MS = 4500; // swap one card every 4.5 s
  let   _homeRotateTimer = null;

  function _rotateOneHomeCard(el) {
    if (!el || document.hidden) return;
    const slots = Array.from(el.children);
    if (!slots.length) return;
    const next = _nextBatch(1);
    if (!next.length) return;

    const idx     = Math.floor(Math.random() * slots.length);
    const oldCard = slots[idx];
    const tmp     = document.createElement('div');
    tmp.innerHTML = _cardHTML(next[0]);
    const newCard = tmp.firstChild;
    if (!newCard) return;

    oldCard.style.transition = 'opacity 0.35s ease';
    oldCard.style.opacity    = '0';
    setTimeout(() => {
      newCard.style.opacity    = '0';
      newCard.style.transition = 'opacity 0.35s ease';
      if (oldCard.parentNode === el) el.replaceChild(newCard, oldCard);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        newCard.style.opacity = '1';
      }));
    }, 350);
  }

  function renderHome(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    _feedEl     = el;
    _feedActive = false;

    el.innerHTML = '';
    _buffer = _buildBuffer();

    const cards = _nextBatch(HOME_LIMIT);
    if (!cards.length) {
      const s = el.closest && el.closest('section');
      if (s) s.style.display = 'none';
      return;
    }
    _appendCards(cards);

    /* Show "Browse More" button */
    const more = document.getElementById('inspiqBrowseMore');
    if (more) more.style.display = 'block';

    /* Start card rotation */
    if (_homeRotateTimer) clearInterval(_homeRotateTimer);
    _homeRotateTimer = setInterval(() => _rotateOneHomeCard(el), HOME_ROTATE_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearInterval(_homeRotateTimer);
      } else {
        _homeRotateTimer = setInterval(() => _rotateOneHomeCard(el), HOME_ROTATE_MS);
      }
    }, { once: false });
  }

  /* ─── PUBLIC API ─── */
  window.InspIQ = {
    track, trackClick, pickInterest, applyPick, applyPickEdit,
    getTopCategories, getPersona, generateCards,
    renderHome, renderForYou, renderPicker, renderPickerEdit, showNotif, hasInterests,
  };

  /* ─── INIT ─── */
  autoTrack();

  function init() {
    _injectStyles();
    const isHomePage = /\/(index\.html)?$/.test(window.location.pathname.split('?')[0]);
    const isInspiqPage = /\/inspiq\.html/.test(window.location.pathname);

    renderPicker('inspiqPicker');

    if (isInspiqPage) {
      /* Always render on the dedicated page — new users see all content */
      renderForYou('inspiqFeed');
    } else if (hasInterests()) {
      /* Home page: only inject widget once user has built up interests */
      renderHome('inspiqFeed');
      setTimeout(showNotif, 3500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
