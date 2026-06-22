/**
 * sokoni-mock-data.js — SOKONI Offline Development Mock Dataset
 * Realistic Kenyan data for all Firestore collections.
 * Consumed by sokoni-dev-mock.js when offline mode activates.
 * Never loaded in production.
 */

(function () {
"use strict";

function ts(daysAgo = 0) {
  const d = new Date(); d.setDate(d.getDate() - daysAgo);
  return { toDate(){ return d; }, toMillis(){ return d.getTime(); }, seconds: Math.floor(d.getTime()/1000), nanoseconds:0, _isMockTimestamp:true };
}

window.SokoniMockData = {

  /* ─── Users ──────────────────────────────────────────────────────────── */
  users: [
    { _id:"mock-admin-001",  uid:"mock-admin-001",  email:"admin@sokoni.co.ke",   displayName:"Admin Sokoni",         phone:"+254700000001", role:"admin",    isAdmin:true,  shopName:null,     createdAt:ts(180) },
    { _id:"mock-seller-001", uid:"mock-seller-001", email:"seller@sokoni.co.ke",  displayName:"Alice Wanjiku",        phone:"+254712345678", role:"seller",   shopName:"Alice Electronics Nairobi", shopSlug:"alice-electronics", verified:true,  categories:["Electronics","Phones"], createdAt:ts(90) },
    { _id:"mock-seller-002", uid:"mock-seller-002", email:"seller2@sokoni.co.ke", displayName:"Kamau Groceries",      phone:"+254722987654", role:"seller",   shopName:"Kamau Fresh Produce",       shopSlug:"kamau-fresh",       verified:true,  categories:["Food","Groceries"],      createdAt:ts(60) },
    { _id:"mock-buyer-001",  uid:"mock-buyer-001",  email:"buyer@sokoni.co.ke",   displayName:"Brian Odhiambo",       phone:"+254733111222", role:"buyer",    shopName:null,     createdAt:ts(30) },
    { _id:"mock-driver-001", uid:"mock-driver-001", email:"driver@sokoni.co.ke",  displayName:"David Maina",          phone:"+254744555666", role:"driver",   vehicle:"TUK 123G Boda", rating:4.8, createdAt:ts(60) },
    { _id:"mock-prov-001",   uid:"mock-prov-001",   email:"provider@sokoni.co.ke",displayName:"Dr. Sarah Njeri",      phone:"+254755999888", role:"provider", specialty:"General Medicine",         hospital:"Nairobi West Clinic", createdAt:ts(45) }
  ],

  /* ─── Products ───────────────────────────────────────────────────────── */
  products: [
    { _id:"prod-001", id:"prod-001", name:"Samsung Galaxy A15 4G", price:18500, stock:12, category:"Phones",       subcategory:"Android",    sellerId:"mock-seller-001", shopName:"Alice Electronics Nairobi", images:["https://placehold.co/400x400?text=Samsung+A15"],       description:"128GB 4GB RAM dual SIM. Brand new, sealed box. Comes with charger and warranty.",  rating:4.6, reviews:23, status:"active", createdAt:ts(10) },
    { _id:"prod-002", id:"prod-002", name:"Infinix Hot 40i",       price:12000, stock:8,  category:"Phones",       subcategory:"Android",    sellerId:"mock-seller-001", shopName:"Alice Electronics Nairobi", images:["https://placehold.co/400x400?text=Infinix+Hot+40"],    description:"256GB storage, 8GB RAM. Great camera for the price.",                               rating:4.3, reviews:11, status:"active", createdAt:ts(8) },
    { _id:"prod-003", id:"prod-003", name:"Laptop HP 245 G10",     price:58000, stock:3,  category:"Electronics",  subcategory:"Laptops",    sellerId:"mock-seller-001", shopName:"Alice Electronics Nairobi", images:["https://placehold.co/400x400?text=HP+Laptop"],         description:"AMD Ryzen 5, 16GB RAM, 512GB SSD. Perfect for students and professionals.",        rating:4.7, reviews:5,  status:"active", createdAt:ts(15) },
    { _id:"prod-004", id:"prod-004", name:"Fresh Sukuma Wiki 1kg", price:30,    stock:200, category:"Food",         subcategory:"Vegetables", sellerId:"mock-seller-002", shopName:"Kamau Fresh Produce",       images:["https://placehold.co/400x400?text=Sukuma+Wiki"],       description:"Freshly harvested kale from Limuru farm. Delivery same day.",                       rating:4.9, reviews:87, status:"active", createdAt:ts(1) },
    { _id:"prod-005", id:"prod-005", name:"Unga Pembe 2kg",        price:195,   stock:50,  category:"Food",         subcategory:"Flour",      sellerId:"mock-seller-002", shopName:"Kamau Fresh Produce",       images:["https://placehold.co/400x400?text=Unga+Pembe"],        description:"Premium maize flour. Fortified with vitamins. 2kg pack.",                          rating:4.8, reviews:42, status:"active", createdAt:ts(2) },
    { _id:"prod-006", id:"prod-006", name:"Nike Air Force 1 (replica)", price:2200, stock:15, category:"Fashion",  subcategory:"Shoes",      sellerId:"mock-seller-001", shopName:"Alice Electronics Nairobi", images:["https://placehold.co/400x400?text=Nike+AF1"],          description:"High quality canvas shoes. Available in all sizes 39-45.",                         rating:4.1, reviews:9,  status:"active", createdAt:ts(5) },
    { _id:"prod-007", id:"prod-007", name:"Kitenge Dress (Ankara)", price:1850, stock:7,  category:"Fashion",      subcategory:"Dresses",    sellerId:"mock-seller-001", shopName:"Alice Electronics Nairobi", images:["https://placehold.co/400x400?text=Kitenge+Dress"],     description:"Handmade Ankara print dress. Custom sizing available. Ships in 3-5 days.",         rating:4.5, reviews:18, status:"active", createdAt:ts(7) },
    { _id:"prod-008", id:"prod-008", name:"Safaricom 5G Home Router",price:8500,stock:6,  category:"Electronics",  subcategory:"Networking", sellerId:"mock-seller-001", shopName:"Alice Electronics Nairobi", images:["https://placehold.co/400x400?text=5G+Router"],         description:"Unlock speeds up to 500Mbps. Supports 32 devices. Plug and play.",                rating:4.4, reviews:31, status:"active", createdAt:ts(12) }
  ],

  /* ─── Orders ─────────────────────────────────────────────────────────── */
  orders: [
    { _id:"order-001", orderId:"order-001", buyerId:"mock-buyer-001",  buyerName:"Brian Odhiambo", buyerPhone:"+254733111222",
      sellerId:"mock-seller-001", shopName:"Alice Electronics Nairobi",
      items:[{ productId:"prod-001", name:"Samsung Galaxy A15 4G", qty:1, price:18500 }],
      total:18500, deliveryFee:200, status:"delivered",
      paymentMethod:"mpesa", paymentRef:"MPE1234567", paymentStatus:"paid",
      deliveryAddress:"Westlands, Nairobi", deliveryCoords:{ lat:-1.2671, lng:36.8028 },
      createdAt:ts(5), deliveredAt:ts(3) },
    { _id:"order-002", orderId:"order-002", buyerId:"mock-buyer-001",  buyerName:"Brian Odhiambo", buyerPhone:"+254733111222",
      sellerId:"mock-seller-002", shopName:"Kamau Fresh Produce",
      items:[
        { productId:"prod-004", name:"Fresh Sukuma Wiki 1kg", qty:3, price:30 },
        { productId:"prod-005", name:"Unga Pembe 2kg",        qty:2, price:195 }
      ],
      total:480, deliveryFee:150, status:"processing",
      paymentMethod:"mpesa", paymentRef:"MPE7654321", paymentStatus:"paid",
      deliveryAddress:"Kilimani, Nairobi", deliveryCoords:{ lat:-1.2897, lng:36.7891 },
      createdAt:ts(0) },
    { _id:"order-003", orderId:"order-003", buyerId:"mock-buyer-001",  buyerName:"Brian Odhiambo", buyerPhone:"+254733111222",
      sellerId:"mock-seller-001", shopName:"Alice Electronics Nairobi",
      items:[{ productId:"prod-003", name:"Laptop HP 245 G10", qty:1, price:58000 }],
      total:58000, deliveryFee:0, status:"pending",
      paymentMethod:"mpesa", paymentRef:null, paymentStatus:"pending",
      deliveryAddress:"Karen, Nairobi",
      createdAt:ts(0) }
  ],

  /* ─── Notifications ──────────────────────────────────────────────────── */
  notifications: [
    { _id:"notif-001", uid:"mock-buyer-001",  type:"order_update",    title:"Order Delivered!",       body:"Your Samsung Galaxy A15 has been delivered. Enjoy!",       read:false, orderId:"order-001",  createdAt:ts(3) },
    { _id:"notif-002", uid:"mock-seller-001", type:"new_order",       title:"New Order #order-002",   body:"Brian Odhiambo placed an order worth KES 480.",            read:false, orderId:"order-002",  createdAt:ts(0) },
    { _id:"notif-003", uid:"mock-admin-001",  type:"new_seller",      title:"New Seller Application", body:"Kamau Groceries has applied to become a seller.",           read:true,  appId:"app-001",      createdAt:ts(7) },
    { _id:"notif-004", uid:"mock-driver-001", type:"ride_request",    title:"Ride Request",           body:"New delivery request: Westlands to Kilimani — KES 350.",   read:false, rideId:"ride-001",    createdAt:ts(0) }
  ],

  /* ─── Reviews ────────────────────────────────────────────────────────── */
  reviews: [
    { _id:"rev-001", productId:"prod-001", buyerId:"mock-buyer-001", buyerName:"Brian Odhiambo", rating:5, comment:"Great phone! Fast delivery, well packaged. Exactly as described.", createdAt:ts(2) },
    { _id:"rev-002", productId:"prod-004", buyerId:"mock-buyer-001", buyerName:"Brian Odhiambo", rating:5, comment:"Very fresh. Will order again!", createdAt:ts(1) }
  ],

  /* ─── Providers ──────────────────────────────────────────────────────── */
  providers: [
    { _id:"mock-prov-001", uid:"mock-prov-001", displayName:"Dr. Sarah Njeri",  category:"Healthcare", specialty:"General Medicine",  hospital:"Nairobi West Clinic",  phone:"+254755999888", email:"provider@sokoni.co.ke", fee:1500, rating:4.8, reviews:34, status:"active",   verified:true,  bio:"5+ years experience in general medicine. Available Mon-Sat 8am-6pm.", createdAt:ts(45) },
    { _id:"prov-002",      uid:"prov-002",      displayName:"Adv. James Kariuki",category:"Legal",      specialty:"Property Law",      firm:"Kariuki & Associates",     phone:"+254766888777", email:"james.kariuki@law.co.ke", fee:5000, rating:4.6, reviews:12, status:"active", verified:true,  bio:"Property law specialist. 10 years experience. Free 15-min consultation.", createdAt:ts(30) }
  ],

  /* ─── Applications ───────────────────────────────────────────────────── */
  applications: [
    { _id:"app-001", uid:"mock-seller-002", displayName:"Kamau Groceries", email:"seller2@sokoni.co.ke", phone:"+254722987654", businessName:"Kamau Fresh Produce", category:"Food & Groceries", status:"approved", reviewNote:"Looks good", createdAt:ts(10) },
    { _id:"app-002", uid:"app-pending-001", displayName:"Juma Electronics", email:"juma@gmail.com",       phone:"+254711333444", businessName:"Juma Tech Hub",       category:"Electronics",      status:"pending",  reviewNote:null,        createdAt:ts(1) }
  ],

  /* ─── Rides ──────────────────────────────────────────────────────────── */
  rides: [
    { _id:"ride-001", riderId:"mock-buyer-001", riderName:"Brian Odhiambo", riderPhone:"+254733111222",
      driverId:"mock-driver-001", driverName:"David Maina", driverPhone:"+254744555666",
      pickup:{ lat:-1.2840, lng:36.8193, address:"Nairobi CBD, Tom Mboya St" },
      dropoff:{ lat:-1.2671, lng:36.8028, address:"Westlands, Nairobi" },
      status:"completed", fare:350, distance:4.2, duration:18,
      paymentMethod:"wallet", createdAt:ts(1) }
  ],

  /* ─── Driver Locations ───────────────────────────────────────────────── */
  driverLocations: [
    { _id:"mock-driver-001", uid:"mock-driver-001", driverName:"David Maina", lat:-1.2840, lng:36.8193, online:true, vehicle:"Boda TUK 123G", rating:4.8, updatedAt:ts(0) }
  ],

  /* ─── Package Requests ───────────────────────────────────────────────── */
  packageRequests: [
    { _id:"pkg-001", senderId:"mock-buyer-001", senderName:"Brian Odhiambo", senderPhone:"+254733111222",
      pickup:{ lat:-1.2840, lng:36.8193, address:"Nairobi CBD" },
      dropoff:{ lat:-1.3031, lng:36.8082, address:"South C, Nairobi" },
      description:"Small parcel - documents", status:"pending", fee:200, createdAt:ts(0) }
  ],

  /* ─── Disputes ───────────────────────────────────────────────────────── */
  disputes: [
    { _id:"disp-001", orderId:"order-001", raisedBy:"mock-buyer-001", raisedByName:"Brian Odhiambo", sellerId:"mock-seller-001", reason:"Item not as described", status:"resolved", resolution:"Full refund issued.", createdAt:ts(4), resolvedAt:ts(2) }
  ],

  /* ─── Escrow ─────────────────────────────────────────────────────────── */
  escrow: [
    { _id:"order-002", orderId:"order-002", buyerId:"mock-buyer-001", sellerId:"mock-seller-002", amount:480, status:"held", createdAt:ts(0) }
  ],

  /* ─── Referrals ──────────────────────────────────────────────────────── */
  referrals: [
    { _id:"ref-001", referrerId:"mock-buyer-001", refereeId:"mock-buyer-002", code:"BRIAN2024", reward:100, status:"credited", createdAt:ts(14) }
  ],

  /* ─── Follows ────────────────────────────────────────────────────────── */
  follows: [
    { _id:"mock-buyer-001_mock-seller-001", followerId:"mock-buyer-001", sellerId:"mock-seller-001", createdAt:ts(20) },
    { _id:"mock-buyer-001_mock-seller-002", followerId:"mock-buyer-001", sellerId:"mock-seller-002", createdAt:ts(15) }
  ],

  /* ─── Broadcasts ─────────────────────────────────────────────────────── */
  broadcasts: [
    { _id:"bc-001", sellerName:"Alice Electronics Nairobi", sellerId:"mock-seller-001", title:"Weekend Flash Sale!", body:"Up to 30% off all phones this Saturday!", url:"/seller.html?shop=alice-electronics", createdAt:ts(1) }
  ],

  /* ─── Order Events ───────────────────────────────────────────────────── */
  orderEvents: [
    { _id:"oe-001", orderId:"order-001", event:"placed",    actor:"mock-buyer-001",  note:"Order placed via web", createdAt:ts(5) },
    { _id:"oe-002", orderId:"order-001", event:"confirmed", actor:"mock-seller-001", note:"Seller confirmed",      createdAt:ts(5) },
    { _id:"oe-003", orderId:"order-001", event:"shipped",   actor:"mock-seller-001", note:"Dispatched via Glovo",  createdAt:ts(4) },
    { _id:"oe-004", orderId:"order-001", event:"delivered", actor:"mock-driver-001", note:"Delivered and signed",  createdAt:ts(3) }
  ],

  /* ─── Driver Earnings ────────────────────────────────────────────────── */
  driverEarnings: [
    { _id:"earn-001", driverId:"mock-driver-001", orderId:"order-001", rideId:"ride-001", amount:280, type:"ride", status:"paid", createdAt:ts(1) }
  ],

  /* ─── Driver Ratings ─────────────────────────────────────────────────── */
  driverRatings: [
    { _id:"drat-001", driverId:"mock-driver-001", riderId:"mock-buyer-001", rating:5, comment:"Very professional and on time.", rideId:"ride-001", createdAt:ts(1) }
  ],

  /* ─── Unboxing Reviews ───────────────────────────────────────────────── */
  unboxingReviews: [
    { _id:"unbox-001", sellerId:"mock-seller-001", reviewerId:"mock-buyer-001", reviewerName:"Brian Odhiambo", videoUrl:null, rating:5, comment:"Great packaging, everything intact.", createdAt:ts(3) }
  ],

  /* ─── Ride Requests ──────────────────────────────────────────────────── */
  rideRequests: [
    { _id:"rreq-001", riderId:"mock-buyer-001", riderName:"Brian Odhiambo", riderPhone:"+254733111222",
      pickup:{ lat:-1.2840, lng:36.8193, address:"Nairobi CBD" },
      dropoff:{ lat:-1.3031, lng:36.8082, address:"South C, Nairobi" },
      status:"open", estimatedFare:350, createdAt:ts(0) }
  ],

  /* ─── Bookings ───────────────────────────────────────────────────────── */
  bookings: [
    { _id:"book-001", clientId:"mock-buyer-001", clientName:"Brian Odhiambo", clientPhone:"+254733111222",
      providerId:"mock-prov-001", providerName:"Dr. Sarah Njeri", category:"Healthcare",
      date:"2026-06-28", time:"10:00 AM", status:"confirmed", fee:1500,
      notes:"General checkup", createdAt:ts(2) }
  ]
};

})();
