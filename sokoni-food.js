/* ============================================================
   SOKONI FOOD HUB  –  window.SokoniFood
   Marketplace food module: cart, orders, menus, promos, ratings
   ============================================================ */
window.SokoniFood = (function () {
  'use strict';

  const fmt  = n => Number(n||0).toLocaleString('en-KE');
  const uid  = () => window.firebase?.auth?.()?.currentUser?.uid || localStorage.getItem('sokoniUID') || 'guest';
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)||'null'); } catch { return null; } };
  const lsSet = (k,v) => localStorage.setItem(k, JSON.stringify(v));
  const lsArr = k => lsGet(k) || [];

  /* ══ CATEGORIES ══ */
  const CATEGORIES = [
    { id:'all',        label:'All',          emoji:'🍽️' },
    { id:'restaurant', label:'Restaurants',  emoji:'🍴' },
    { id:'fastfood',   label:'Fast Food',    emoji:'🍔' },
    { id:'grocery',    label:'Groceries',    emoji:'🛒' },
    { id:'homechef',   label:'Home Chef',    emoji:'👩‍🍳' },
    { id:'catering',   label:'Catering',     emoji:'🥘' },
    { id:'bakery',     label:'Bakery',       emoji:'🍰' },
    { id:'butchery',   label:'Butchery',     emoji:'🥩' },
  ];

  /* ══ RESTAURANT DATA ══ */
  const RESTAURANTS = [
    { id:'jambo-burgers', name:'Jambo Burgers', cat:'fastfood', emoji:'🍔',
      rating:4.5, reviews:892, deliveryTime:'20-30 min', deliveryFee:79,
      minOrder:350, distance:'0.8 km', featured:true, open:true,
      promo:'Free fries on orders KES 800+',
      tags:['Burgers','Fries','Milkshakes','Wraps'],
      address:'Westlands, Nairobi', phone:'0700111001',
      coverGrad:'linear-gradient(135deg,rgba(255,107,53,0.25),rgba(245,158,11,0.15))' },
    { id:'chicken-master', name:'Chicken Master', cat:'fastfood', emoji:'🍗',
      rating:4.2, reviews:654, deliveryTime:'25-35 min', deliveryFee:99,
      minOrder:400, distance:'1.5 km', featured:true, open:true,
      promo:'20% OFF your first order',
      tags:['Chicken','Wings','Grills','Deals'],
      address:'Karen, Nairobi', phone:'0700111002',
      coverGrad:'linear-gradient(135deg,rgba(245,158,11,0.25),rgba(255,107,53,0.15))' },
    { id:'safari-grill', name:'Safari Grill', cat:'restaurant', emoji:'🥩',
      rating:4.7, reviews:1240, deliveryTime:'35-45 min', deliveryFee:149,
      minOrder:1000, distance:'2.1 km', featured:true, open:true, promo:null,
      tags:['Nyama Choma','Ugali','Kenyan','BBQ'],
      address:'Westlands, Nairobi', phone:'0700111003',
      coverGrad:'linear-gradient(135deg,rgba(16,185,129,0.25),rgba(5,150,105,0.15))' },
    { id:'java-house', name:'Java House', cat:'restaurant', emoji:'☕',
      rating:4.4, reviews:2100, deliveryTime:'30-40 min', deliveryFee:99,
      minOrder:500, distance:'1.8 km', featured:false, open:true, promo:null,
      tags:['Coffee','Breakfast','Sandwiches','Cafe'],
      address:'CBD, Nairobi', phone:'0700111004',
      coverGrad:'linear-gradient(135deg,rgba(139,92,246,0.25),rgba(109,40,217,0.15))' },
    { id:'pizza-palace', name:'Pizza Palace', cat:'restaurant', emoji:'🍕',
      rating:4.3, reviews:780, deliveryTime:'30-40 min', deliveryFee:99,
      minOrder:500, distance:'1.2 km', featured:false, open:true,
      promo:'Buy 1 Get 1 on Tuesdays',
      tags:['Pizza','Pasta','Italian','Family'],
      address:'Kilimani, Nairobi', phone:'0700111005',
      coverGrad:'linear-gradient(135deg,rgba(239,68,68,0.25),rgba(185,28,28,0.15))' },
    { id:'thai-garden', name:'Thai Garden', cat:'restaurant', emoji:'🍜',
      rating:4.6, reviews:430, deliveryTime:'35-50 min', deliveryFee:149,
      minOrder:800, distance:'3.2 km', featured:false, open:true, promo:null,
      tags:['Thai','Noodles','Curries','Vegetarian'],
      address:'Gigiri, Nairobi', phone:'0700111006',
      coverGrad:'linear-gradient(135deg,rgba(6,182,212,0.25),rgba(8,145,178,0.15))' },
    { id:'fresh-mart', name:'Fresh Mart', cat:'grocery', emoji:'🛒',
      rating:4.1, reviews:340, deliveryTime:'45-60 min', deliveryFee:149,
      minOrder:500, distance:'0.5 km', featured:false, open:true, promo:null,
      tags:['Groceries','Fresh Produce','Dairy','Everyday'],
      address:'Parklands, Nairobi', phone:'0700111007',
      coverGrad:'linear-gradient(135deg,rgba(34,197,94,0.25),rgba(21,128,61,0.15))' },
    { id:'supermart-express', name:'Supermart Express', cat:'grocery', emoji:'🏪',
      rating:4.2, reviews:210, deliveryTime:'50-70 min', deliveryFee:199,
      minOrder:1000, distance:'3.2 km', featured:false, open:true, promo:null,
      tags:['Supermarket','Wholesale','Household'],
      address:'Lavington, Nairobi', phone:'0700111008',
      coverGrad:'linear-gradient(135deg,rgba(59,130,246,0.25),rgba(29,78,216,0.15))' },
    { id:'mama-wanjiru', name:"Mama Wanjiru's Kitchen", cat:'homechef', emoji:'👩‍🍳',
      rating:4.8, reviews:156, deliveryTime:'60-90 min', deliveryFee:99,
      minOrder:800, distance:'2.5 km', featured:true, open:true, promo:null,
      tags:['Home Cooked','Githeri','Ugali','Kenyan Soul Food'],
      address:'Ngong Road, Nairobi', phone:'0700111009',
      coverGrad:'linear-gradient(135deg,rgba(236,72,153,0.25),rgba(190,24,93,0.15))' },
    { id:'chef-kamau', name:'Chef Kamau BBQ', cat:'homechef', emoji:'👨‍🍳',
      rating:4.9, reviews:89, deliveryTime:'90-120 min', deliveryFee:149,
      minOrder:1500, distance:'4.0 km', featured:false, open:true, promo:null,
      tags:['BBQ','Nyama Choma','Goat','Private Chef'],
      address:'Kileleshwa, Nairobi', phone:'0700111010',
      coverGrad:'linear-gradient(135deg,rgba(249,115,22,0.25),rgba(194,65,12,0.15))' },
    { id:'royal-catering', name:'Royal Events Catering', cat:'catering', emoji:'🍽️',
      rating:4.6, reviews:67, deliveryTime:'24hr notice', deliveryFee:0,
      minOrder:10000, distance:'8.0 km', featured:false, open:true,
      promo:'Free setup for 50+ pax',
      tags:['Events','Corporate','Weddings','Buffet'],
      address:'Upperhill, Nairobi', phone:'0700111011',
      coverGrad:'linear-gradient(135deg,rgba(245,158,11,0.25),rgba(180,83,9,0.15))' },
    { id:'savanna-catering', name:'Savanna Catering', cat:'catering', emoji:'🥘',
      rating:4.5, reviews:45, deliveryTime:'48hr notice', deliveryFee:0,
      minOrder:5000, distance:'5.0 km', featured:false, open:true, promo:null,
      tags:['African Cuisine','Corporate','Events','Affordable'],
      address:'Nairobi West', phone:'0700111012',
      coverGrad:'linear-gradient(135deg,rgba(16,185,129,0.25),rgba(4,120,87,0.15))' },
    { id:'sunrise-bakery', name:'Sunrise Bakery', cat:'bakery', emoji:'🍰',
      rating:4.7, reviews:445, deliveryTime:'30-45 min', deliveryFee:79,
      minOrder:300, distance:'1.1 km', featured:true, open:true,
      promo:'Free delivery on cakes KES 2000+',
      tags:['Cakes','Bread','Pastries','Custom Cakes'],
      address:'South B, Nairobi', phone:'0700111013',
      coverGrad:'linear-gradient(135deg,rgba(236,72,153,0.25),rgba(157,23,77,0.15))' },
    { id:'artisan-breads', name:'The Artisan Bread Co.', cat:'bakery', emoji:'🥖',
      rating:4.4, reviews:220, deliveryTime:'35-50 min', deliveryFee:99,
      minOrder:400, distance:'2.0 km', featured:false, open:true, promo:null,
      tags:['Sourdough','Croissants','Coffee','Pastries'],
      address:'Gigiri, Nairobi', phone:'0700111014',
      coverGrad:'linear-gradient(135deg,rgba(251,191,36,0.25),rgba(180,83,9,0.15))' },
    { id:'prime-cuts', name:'Prime Cuts Butchery', cat:'butchery', emoji:'🥩',
      rating:4.3, reviews:178, deliveryTime:'40-55 min', deliveryFee:99,
      minOrder:500, distance:'0.9 km', featured:false, open:true, promo:null,
      tags:['Beef','Goat','Chicken','Pork','Fresh'],
      address:'Kasarani, Nairobi', phone:'0700111015',
      coverGrad:'linear-gradient(135deg,rgba(239,68,68,0.25),rgba(153,27,27,0.15))' },
    { id:'halal-meats', name:'Halal Quality Meats', cat:'butchery', emoji:'🐄',
      rating:4.5, reviews:234, deliveryTime:'45-60 min', deliveryFee:99,
      minOrder:600, distance:'1.7 km', featured:false, open:true, promo:null,
      tags:['Halal','Beef','Lamb','Goat','Fresh'],
      address:'Eastleigh, Nairobi', phone:'0700111016',
      coverGrad:'linear-gradient(135deg,rgba(16,185,129,0.25),rgba(4,120,87,0.15))' },
  ];

  /* ══ MENUS ══ */
  const MENUS = {
    'jambo-burgers': {
      cats:['Burgers','Wraps','Sides','Drinks','Combo Deals'],
      items:[
        {id:'jb1',cat:'Burgers',name:'Classic Beef Burger',price:450,desc:'Juicy beef patty, lettuce, tomato, pickles, special sauce',popular:true},
        {id:'jb2',cat:'Burgers',name:'Double Stack Burger',price:650,desc:'Double beef patty, double cheese, bacon, gherkin, mayo',popular:true},
        {id:'jb3',cat:'Burgers',name:'Crispy Chicken Burger',price:480,desc:'Crispy fried chicken fillet, coleslaw, chilli sauce',popular:false},
        {id:'jb4',cat:'Burgers',name:'Veggie Avocado Burger',price:380,desc:'Black bean patty, avocado, fresh salad, chipotle mayo',popular:false},
        {id:'jb5',cat:'Burgers',name:'BBQ Bacon Burger',price:720,desc:'Double patty, bacon strips, BBQ sauce, caramelised onions',popular:false},
        {id:'jb6',cat:'Wraps',name:'Chicken Tikka Wrap',price:390,desc:'Marinated chicken tikka, cucumber raita, mango chutney',popular:true},
        {id:'jb7',cat:'Wraps',name:'Beef Shawarma Wrap',price:420,desc:'Spiced beef, garlic sauce, pickled vegetables, tortilla',popular:false},
        {id:'jb8',cat:'Sides',name:'Large Fries',price:180,desc:'Crispy golden fries with seasoning',popular:true},
        {id:'jb9',cat:'Sides',name:'Onion Rings',price:220,desc:'Beer-battered onion rings with dipping sauce',popular:false},
        {id:'jb10',cat:'Sides',name:'Coleslaw',price:120,desc:'Creamy homemade coleslaw',popular:false},
        {id:'jb11',cat:'Drinks',name:'Mango Milkshake',price:280,desc:'Fresh mango, ice cream, milk. 500ml',popular:true},
        {id:'jb12',cat:'Drinks',name:'Coca-Cola 500ml',price:120,desc:'Ice cold Coca-Cola',popular:false},
        {id:'jb13',cat:'Drinks',name:'Fresh Juice 400ml',price:200,desc:'Orange, passion, mango or pineapple',popular:false},
        {id:'jb14',cat:'Combo Deals',name:'Classic Combo',price:720,desc:'Classic Burger + Large Fries + Any Drink',popular:true},
        {id:'jb15',cat:'Combo Deals',name:'Double Deal',price:980,desc:'Double Stack + Onion Rings + Milkshake',popular:false},
      ]
    },
    'chicken-master': {
      cats:['Chicken','Wings','Sides','Deals','Drinks'],
      items:[
        {id:'cm1',cat:'Chicken',name:'2-Piece Meal',price:580,desc:'2 pieces chicken + fries + coleslaw',popular:true},
        {id:'cm2',cat:'Chicken',name:'4-Piece Meal',price:980,desc:'4 pieces chicken + large fries + coleslaw + drink',popular:true},
        {id:'cm3',cat:'Chicken',name:'Half Chicken',price:780,desc:'Marinated half chicken, seasoned fries',popular:false},
        {id:'cm4',cat:'Wings',name:'6 Wings',price:480,desc:'Crispy wings. Choice: BBQ, Spicy, Honey Garlic',popular:true},
        {id:'cm5',cat:'Wings',name:'12 Wings',price:880,desc:'Party bucket wings. Choice of 2 sauces',popular:false},
        {id:'cm6',cat:'Sides',name:'Spicy Rice',price:180,desc:'Jollof-style spiced rice',popular:true},
        {id:'cm7',cat:'Sides',name:'Mashed Potatoes',price:160,desc:'Creamy butter mashed potatoes with gravy',popular:false},
        {id:'cm8',cat:'Deals',name:'Family Feast',price:2400,desc:'8 pieces + 2 large fries + coleslaw + 4 drinks',popular:true},
        {id:'cm9',cat:'Drinks',name:'Soft Drink 500ml',price:120,desc:'Coke, Fanta, Sprite',popular:false},
      ]
    },
    'safari-grill': {
      cats:["Nyama Choma","Ugali & Sides","Starters","Seafood","Drinks"],
      items:[
        {id:'sg1',cat:'Nyama Choma',name:'Goat Ribs 500g',price:1200,desc:'Freshly grilled goat ribs, kachumbari, ugali',popular:true},
        {id:'sg2',cat:'Nyama Choma',name:'Beef Choma 500g',price:1100,desc:'Tender grilled beef, kachumbari, ugali or chips',popular:true},
        {id:'sg3',cat:'Nyama Choma',name:'Whole Grilled Chicken',price:1400,desc:'Marinated spatchcock chicken, charcoal grilled',popular:false},
        {id:'sg4',cat:'Nyama Choma',name:'Mixed Choma Platter',price:2800,desc:'Goat, beef, chicken. Serves 3-4 people',popular:false},
        {id:'sg5',cat:'Ugali & Sides',name:'Ugali + Sukuma Wiki',price:250,desc:'Ugali ya mahindi with sukuma wiki in onion gravy',popular:true},
        {id:'sg6',cat:'Ugali & Sides',name:'Mukimo',price:280,desc:'Mashed potatoes with peas and corn',popular:false},
        {id:'sg7',cat:'Starters',name:'Kachumbari',price:180,desc:'Fresh tomato and onion salad',popular:true},
        {id:'sg8',cat:'Starters',name:'Samosas (4)',price:280,desc:'Crispy beef or veggie samosas',popular:false},
        {id:'sg9',cat:'Seafood',name:'Grilled Tilapia',price:980,desc:'Whole grilled tilapia, ugali, sukuma wiki',popular:true},
        {id:'sg10',cat:'Drinks',name:'Tusker Beer 500ml',price:320,desc:'Cold Kenyan lager',popular:true},
        {id:'sg11',cat:'Drinks',name:'Fresh Passion Juice',price:200,desc:'Freshly squeezed passion fruit juice',popular:false},
      ]
    },
    'mama-wanjiru': {
      cats:["Today's Menu","Ugali Meals","Rice Dishes","Snacks","Drinks"],
      items:[
        {id:'mw1',cat:"Today's Menu",name:'Ugali + Beef Stew',price:350,desc:'Soft ugali with slow-cooked beef in tomato stew',popular:true},
        {id:'mw2',cat:"Today's Menu",name:'Githeri Special',price:280,desc:'Mixed maize and beans, fried with veggies',popular:true},
        {id:'mw3',cat:'Ugali Meals',name:'Ugali + Chicken',price:420,desc:'Ugali with stewed chicken pieces',popular:false},
        {id:'mw4',cat:'Ugali Meals',name:'Ugali + Fried Fish',price:380,desc:'Ugali with tilapia fillet',popular:false},
        {id:'mw5',cat:'Rice Dishes',name:'Kenyan Pilau',price:350,desc:'Spiced pilau rice with beef',popular:true},
        {id:'mw6',cat:'Rice Dishes',name:'Coconut Rice + Beans',price:300,desc:'Coconut rice with kidney beans',popular:false},
        {id:'mw7',cat:'Snacks',name:'Mandazi (3)',price:120,desc:'Sweet fried dough. Perfect with tea',popular:true},
        {id:'mw8',cat:'Drinks',name:'Masala Chai',price:80,desc:'Homemade spiced chai with milk',popular:true},
      ]
    },
    'sunrise-bakery': {
      cats:['Cakes','Bread','Pastries','Savoury','Coffee & Drinks'],
      items:[
        {id:'sb1',cat:'Cakes',name:'Chocolate Fudge (slice)',price:380,desc:'Rich chocolate cake with fudge frosting',popular:true},
        {id:'sb2',cat:'Cakes',name:'Birthday Cake 1kg',price:2500,desc:'Custom birthday cake. 24hr order required.',popular:false},
        {id:'sb3',cat:'Cakes',name:'Red Velvet Whole',price:2800,desc:'Classic red velvet, cream cheese frosting. 1.2kg',popular:true},
        {id:'sb4',cat:'Cakes',name:'Carrot Cake (slice)',price:350,desc:'Moist carrot cake with walnut cream frosting',popular:false},
        {id:'sb5',cat:'Bread',name:'White Sandwich Loaf',price:95,desc:'Freshly baked white bread',popular:true},
        {id:'sb6',cat:'Bread',name:'Whole Wheat Loaf',price:115,desc:'Healthy whole wheat bread',popular:false},
        {id:'sb7',cat:'Pastries',name:'Butter Croissant',price:180,desc:'Flaky buttery French-style croissant',popular:true},
        {id:'sb8',cat:'Pastries',name:'Cinnamon Roll',price:200,desc:'Soft roll with cream cheese glaze',popular:false},
        {id:'sb9',cat:'Savoury',name:'Cheese & Egg Quiche',price:320,desc:'Rich egg and cheddar tart in buttery pastry',popular:false},
        {id:'sb10',cat:'Coffee & Drinks',name:'Cappuccino',price:280,desc:'Espresso with steamed milk foam',popular:true},
        {id:'sb11',cat:'Coffee & Drinks',name:'Fresh Orange Juice',price:220,desc:'Freshly squeezed oranges',popular:false},
      ]
    },
    'fresh-mart': {
      cats:['Fresh Produce','Dairy & Eggs','Meat & Fish','Grains & Staples','Household'],
      items:[
        {id:'fm1',cat:'Fresh Produce',name:'Tomatoes 1kg',price:120,desc:'Fresh farm tomatoes',popular:true},
        {id:'fm2',cat:'Fresh Produce',name:'Red Onions 1kg',price:80,desc:'Fresh red onions',popular:true},
        {id:'fm3',cat:'Fresh Produce',name:'Mixed Greens Bundle',price:150,desc:'Sukuma wiki, spinach, kale bundle',popular:true},
        {id:'fm4',cat:'Fresh Produce',name:'Avocados (4)',price:200,desc:'Large Hass avocados',popular:false},
        {id:'fm5',cat:'Fresh Produce',name:'Bananas (bunch)',price:120,desc:'Fresh ripe bananas',popular:false},
        {id:'fm6',cat:'Dairy & Eggs',name:'Fresh Milk 1L',price:65,desc:'Pasteurised fresh milk',popular:true},
        {id:'fm7',cat:'Dairy & Eggs',name:'Eggs (tray of 30)',price:480,desc:'Free-range eggs, tray of 30',popular:true},
        {id:'fm8',cat:'Dairy & Eggs',name:'Yoghurt 500g',price:180,desc:'Plain or flavoured yoghurt',popular:false},
        {id:'fm9',cat:'Grains & Staples',name:'Maize Flour 2kg',price:180,desc:'Unga wa mahindi',popular:true},
        {id:'fm10',cat:'Grains & Staples',name:'Rice 2kg',price:260,desc:'Long grain white rice',popular:false},
        {id:'fm11',cat:'Household',name:'Washing Powder 1kg',price:220,desc:'Omo detergent, 1kg pack',popular:false},
        {id:'fm12',cat:'Household',name:'Cooking Oil 1L',price:280,desc:'Refined vegetable oil',popular:true},
      ]
    },
    'prime-cuts': {
      cats:['Beef','Goat & Lamb','Chicken','Pork','Offal & Extras'],
      items:[
        {id:'pc1',cat:'Beef',name:'Beef Mince 500g',price:380,desc:'Fresh ground beef mince',popular:true},
        {id:'pc2',cat:'Beef',name:'T-Bone Steak ~300g',price:680,desc:'Premium T-bone for grilling',popular:true},
        {id:'pc3',cat:'Beef',name:'Beef Short Ribs 1kg',price:720,desc:'Meaty ribs, perfect for BBQ',popular:false},
        {id:'pc4',cat:'Beef',name:'Stewing Beef 1kg',price:620,desc:'Lean beef pieces for stew',popular:false},
        {id:'pc5',cat:'Goat & Lamb',name:'Goat Meat 1kg',price:820,desc:'Fresh goat, mixed cuts',popular:true},
        {id:'pc6',cat:'Goat & Lamb',name:'Goat Ribs 500g',price:480,desc:'Choma-ready ribs',popular:false},
        {id:'pc7',cat:'Chicken',name:'Whole Chicken ~1.5kg',price:520,desc:'Fresh whole chicken',popular:true},
        {id:'pc8',cat:'Chicken',name:'Chicken Pieces 1kg',price:380,desc:'Mixed thighs and drumsticks',popular:false},
        {id:'pc9',cat:'Pork',name:'Pork Belly 500g',price:380,desc:'Fresh pork belly slices',popular:false},
        {id:'pc10',cat:'Offal & Extras',name:'Mutura 500g',price:280,desc:'Traditional Kenyan blood sausage',popular:true},
      ]
    },
    'royal-catering': {
      cats:['Wedding Packages','Corporate Buffet','Birthday Events','Setup Services'],
      items:[
        {id:'rc1',cat:'Wedding Packages',name:'Silver Wedding (100 guests)',price:85000,desc:'3-course meal, serving staff, tables, chairs, décor',popular:true},
        {id:'rc2',cat:'Wedding Packages',name:'Gold Wedding (200 guests)',price:150000,desc:'4-course, live stations, MC, full decor, champagne',popular:false},
        {id:'rc3',cat:'Corporate Buffet',name:'Corporate Lunch (per head)',price:1200,desc:'Min 30 pax. 3 mains, 2 salads, drinks',popular:true},
        {id:'rc4',cat:'Birthday Events',name:'Birthday Package (50 guests)',price:45000,desc:'Food, birthday cake, serving staff, décor',popular:false},
        {id:'rc5',cat:'Setup Services',name:'Tent + Chairs + Tables (50 pax)',price:12000,desc:'Full setup for 50 people',popular:false},
      ]
    },
  };

  /* Fill any restaurant without a menu with defaults */
  RESTAURANTS.forEach(r => {
    if (!MENUS[r.id]) {
      MENUS[r.id] = {
        cats:['Menu'],
        items:[
          {id:r.id+'-1',cat:'Menu',name:'Signature Special',price:r.minOrder,desc:"Chef's signature dish",popular:true},
          {id:r.id+'-2',cat:'Menu',name:'Combo Value Meal',price:Math.round(r.minOrder*1.5),desc:'Best value combo',popular:false},
        ]
      };
    }
  });

  /* ══ PROMO CODES ══ */
  const SYSTEM_PROMOS = [
    {code:'WELCOME50',type:'percent',value:50,max:500,minOrder:500,uses:1,desc:'50% OFF first Sokoni Food order'},
    {code:'FOOD20',type:'percent',value:20,max:300,minOrder:800,uses:10,desc:'20% OFF any food order'},
    {code:'FREEDELIVERY',type:'delivery',value:200,max:200,minOrder:600,uses:5,desc:'Free delivery on your order'},
    {code:'FRIDAY200',type:'flat',value:200,max:200,minOrder:1000,uses:3,desc:'KES 200 OFF every Friday'},
    {code:'SOKONI10',type:'percent',value:10,max:150,minOrder:400,uses:20,desc:'10% OFF – Sokoni member discount'},
  ];

  function validatePromo(code, subtotal){
    const all=[...SYSTEM_PROMOS,...lsArr('food_vendor_promos')];
    const promo=all.find(p=>p.code.toUpperCase()===code.toUpperCase());
    if(!promo) return {valid:false,error:'Invalid promo code'};
    if(subtotal<promo.minOrder) return {valid:false,error:`Minimum order KES ${fmt(promo.minOrder)} required`};
    const used=Number(lsGet('promo_used_'+code.toLowerCase())||0);
    if(used>=promo.uses) return {valid:false,error:'Promo code limit reached'};
    let discount=0;
    if(promo.type==='percent') discount=Math.min(subtotal*promo.value/100,promo.max);
    else if(promo.type==='flat') discount=promo.value;
    else if(promo.type==='delivery') discount=Math.min(promo.value,promo.max);
    return {valid:true,promo,discount:Math.round(discount)};
  }

  function usePromo(code){
    const k='promo_used_'+code.toLowerCase();
    lsSet(k,Number(lsGet(k)||0)+1);
  }

  /* ══ CART — the SAME cart every other surface uses, with type:'food' rows ══

     Canonical (Track 2.5). This file held a complete parallel cart implementation on the
     same key, reached through `const SHARED_CART_KEY = 'cart'` — which is exactly why the
     literal-only scanner could not see it and it survived three migration slices while
     the reports quoted confident writer counts.

     It is now the last consumer to move onto SokoniCart, and its three peculiarities are
     preserved rather than normalised:

       saveCart()   is a WHOLE-ARRAY replace: non-food rows first, then every food row.
                    That ordering is observable — checkout reads cart[0] for pickupCoords
                    and the seller id — so it is kept exactly, as one write.
       addToCart()  merges on itemId + restaurantId, its OWN rule. Not id, not cartId. The
                    service's merge:true would key on the wrong field, so the array is
                    assembled here and handed to replace().
       clearCart()  empties the FOOD rows only. SokoniCart.clear() would take the
                    shopper's products with it. */
  function _svc(){ return window.SokoniCart || null; }

  /* Returns null — not [] — when the cart cannot be read. Callers decide what to do with
     "unknown"; none of them may treat it as "empty". */
  function _allItemsOrNull(){ const c=_svc(); return c ? c.list() : null; }
  function _allItems(){
    const a=_allItemsOrNull();
    if(a===null){
      try{ console.error('[SOKONI] food: SokoniCart unavailable — the food cart cannot be read'); }catch(e){}
      return [];
    }
    return a;
  }
  function _saveAll(items){ const c=_svc(); return c ? c.replace(items) : false; }

  function getCart(){ return _allItems().filter(i=>i.type==='food'); }

  function saveCart(foodItems){
    const all=_allItemsOrNull();
    /* Refuse rather than rebuild the cart from an assumed-empty read: `rest` would come
       out empty and the shopper's product rows would be deleted by a food mutation. */
    if(all===null){
      try{ console.error('[SOKONI] food: refusing to save — the cart is unreadable'); }catch(e){}
      return false;
    }
    const rest=all.filter(i=>i.type!=='food');
    const ok=_saveAll([...rest,...foodItems]);
    _updateBadge();
    return ok;
  }

  function addToCart(restaurantId,restaurantName,restaurantEmoji,item,qty=1,note=''){
    const cart=getCart();
    const ex=cart.find(c=>c.itemId===item.id&&c.restaurantId===restaurantId);
    if(ex){ ex.qty+=qty; }
    else{
      cart.push({
        type:'food',
        cartId:'CI'+Date.now()+Math.random().toString(36).slice(2,6),
        restaurantId,restaurantName,restaurantEmoji,
        itemId:item.id,name:item.name,price:item.price,qty,note,
      });
    }
    saveCart(cart);
    return getCartCount();
  }

  function removeFromCart(cartId){ return saveCart(getCart().filter(c=>c.cartId!==cartId)); }

  function updateQty(cartId,qty){
    const cart=getCart();
    const item=cart.find(c=>c.cartId===cartId);
    if(!item) return false;
    if(qty<=0){ return removeFromCart(cartId); }
    item.qty=qty; return saveCart(cart);
  }

  /* FOOD rows only. Deliberately not SokoniCart.clear(), which empties the whole cart —
     ordering food and then clearing it must not remove the shopper's products. */
  function clearCart(){ return saveCart([]); }
  function getCartCount(){ return getCart().reduce((s,c)=>s+c.qty,0); }

  function getCartByVendor(){
    const cart=getCart();
    const vendors={};
    cart.forEach(item=>{
      if(!vendors[item.restaurantId]){
        vendors[item.restaurantId]={
          restaurantId:item.restaurantId,
          restaurantName:item.restaurantName,
          restaurantEmoji:item.restaurantEmoji,
          items:[],subtotal:0,
        };
      }
      vendors[item.restaurantId].items.push(item);
      vendors[item.restaurantId].subtotal+=item.price*item.qty;
    });
    return Object.values(vendors);
  }

  function _updateBadge(){
    /* Counts ALL cart items (food + products) for the shared badge — Σ(qty||1), which is
       exactly SokoniCart.units(), the formula every badge on the platform converged on.
       A like-for-like swap: this number does not move.

       With no service the badge goes blank and hidden rather than 0, since an
       unverifiable count must not assert an empty cart. */
    const c=_svc();
    const total=c?c.units():null;
    document.querySelectorAll('.food-cart-badge,.sk-cart-pip').forEach(el=>{
      el.textContent=(total==null||!total)?'':total;
      el.style.display=total?'flex':'none';
    });
  }

  /* ══ ORDERS ══ */
  const ORDERS_KEY='sokoni_food_orders';
  const STATUS_LABELS={
    placed:'Order Placed',confirmed:'Confirmed by Restaurant',preparing:'Preparing Your Food',
    ready:'Ready for Pickup',picked_up:'Rider Has Your Order',delivered:'Delivered!'
  };
  const STATUS_ICONS={placed:'📋',confirmed:'✅',preparing:'🍳',ready:'📦',picked_up:'🛵',delivered:'🏠'};

  function placeOrder(data){
    const order={
      id:'FD'+Date.now(),
      uid:uid(),
      ...data,
      status:'placed',
      statusHistory:[{status:'placed',ts:Date.now()}],
      commission:Math.round((data.subtotal||0) * (SokoniCommission.pct("food_delivery") / 100)),
      createdAt:Date.now(),
    };
    const orders=lsArr(ORDERS_KEY);
    orders.unshift(order);
    lsSet(ORDERS_KEY,orders.slice(0,300));
    /* Firestore */
    try{ if(window.SokoniDB?.saveApplication) SokoniDB.saveApplication({...order,category:'food_orders'}); }catch{}
    /* Commission */
    try{ if(window.SokoniPay?.saveFee) SokoniPay.saveFee({
      ref:order.id,providerName:(data.vendors||[]).map(v=>v.restaurantName).join(', ')||'Food Order',
      category:'food',depositAmount:data.total||0,commissionPct:10,phone:data.phone||'',
      serviceDesc:'Food Delivery Order',status:'pending',createdAt:Date.now(),
    }); }catch{}
    /* Push notification */
    try{
      if('Notification' in window && Notification.permission==='granted'){
        new Notification('SOKONI Food 🍽️',{
          body:`Order #${order.id.slice(-6)} placed! ${data.deliveryMethod==='pickup'?'Ready in':'Estimated'} ${data.deliveryTime||'30-45 min'}`,
          icon:'/assets/logosokoni.png',tag:'food-order-'+order.id,
        });
      }
    }catch{}
    return order;
  }

  /* Persist an order that the CALLER has already built and whose side-effects the
     caller owns (Firestore write, commission, invoice) — this is the food-menu
     checkout's post-payment path. Use placeOrder() instead when you want this
     module to build the order and run those side-effects for you; calling both
     would double-record commission.
     Idempotent by order id: M-Pesa success callbacks can fire more than once, and
     a paid order must never be written twice. */
  function saveOrder(order){
    if(!order || !order.id) return null;
    const orders=lsArr(ORDERS_KEY);
    if(orders.some(o=>o.id===order.id)) return order;
    orders.unshift({ uid:uid(), createdAt:Date.now(), ...order });
    lsSet(ORDERS_KEY,orders.slice(0,300));
    return order;
  }

  function getOrders(){ return lsArr(ORDERS_KEY); }
  function getOrderById(id){ return getOrders().find(o=>o.id===id); }

  function updateOrderStatus(id,status){
    const orders=lsArr(ORDERS_KEY);
    const order=orders.find(o=>o.id===id); if(!order) return null;
    order.status=status;
    order.statusHistory=[...(order.statusHistory||[]),{status,ts:Date.now()}];
    lsSet(ORDERS_KEY,orders);
    try{ if(window.SokoniDB?.saveApplication) SokoniDB.saveApplication({...order,category:'food_orders'}); }catch{}
    return order;
  }

  /* ══ RATINGS ══ */
  function saveRating(restaurantId,rating,comment){
    const k='food_ratings_'+restaurantId;
    const arr=lsArr(k);
    arr.unshift({id:'R'+Date.now(),restaurantId,rating:Number(rating),comment,uid:uid(),ts:Date.now()});
    lsSet(k,arr.slice(0,50));
    try{ if(window.SokoniDB?.saveApplication) SokoniDB.saveApplication({restaurantId,rating,comment,category:'food_reviews',uid:uid(),ts:Date.now()}); }catch{}
  }

  function getRatings(restaurantId){ return lsArr('food_ratings_'+restaurantId); }

  function getRestaurantRating(restaurantId){
    const r=RESTAURANTS.find(r=>r.id===restaurantId);
    const stored=getRatings(restaurantId);
    if(!stored.length) return {avg:r?.rating||4.0,count:r?.reviews||0};
    const avg=stored.reduce((s,r)=>s+r.rating,0)/stored.length;
    return {avg:Math.round(avg*10)/10,count:stored.length+(r?.reviews||0)};
  }

  function starsHTML(rating,small=false){
    const full=Math.floor(rating),half=(rating%1)>=0.5,empty=5-full-(half?1:0);
    const s=small?'font-size:11px;':'font-size:13px;';
    return `<span style="${s}color:#f59e0b;">${'★'.repeat(full)}${half?'☆':''}${'☆'.repeat(empty)}</span>`;
  }

  /* ══ RIDER ══ */
  function updateRiderLocation(orderId,lat,lng){
    lsSet('rider_loc_'+orderId,{lat,lng,ts:Date.now()});
    try{ if(window.SokoniDB?.saveApplication) SokoniDB.saveApplication({orderId,lat,lng,category:'food_riders',uid:uid(),ts:Date.now()}); }catch{}
  }

  function getRiderLocation(orderId){
    return lsGet('rider_loc_'+orderId)||{lat:-1.2921,lng:36.8219};
  }

  function getAvailableOrders(){ return getOrders().filter(o=>o.status==='ready'); }

  function getVendorOrders(restaurantId){
    return getOrders().filter(o=>(o.vendors||[]).some(v=>v.restaurantId===restaurantId));
  }

  /* ══ INIT ══ */
  document.addEventListener('DOMContentLoaded',()=>{ _updateBadge(); });

  return {
    RESTAURANTS,MENUS,CATEGORIES,SYSTEM_PROMOS,
    getCart,addToCart,removeFromCart,updateQty,clearCart,getCartCount,getCartByVendor,
    placeOrder,saveOrder,getOrders,getOrderById,updateOrderStatus,STATUS_LABELS,STATUS_ICONS,
    validatePromo,usePromo,
    saveRating,getRatings,getRestaurantRating,starsHTML,
    updateRiderLocation,getRiderLocation,getAvailableOrders,getVendorOrders,
    fmt,
  };
})();
