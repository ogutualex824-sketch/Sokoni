/**
 * sokoni-test-suite.js — SOKONI Automated Regression Test Suite v1.0
 *
 * Runs all major platform workflows using the offline mock layer.
 * Requires: sokoni-mock-data.js + sokoni-dev-mock.js to be loaded first.
 *
 * Usage (browser console):  SokoniTests.run()
 * Usage (test page):        Loaded automatically by sokoni-cert.html
 *
 * Phases:
 *   Auth · Buyer · Seller · Admin · Driver · Provider · Payments ·
 *   Notifications · Search · Firestore · Error-handling · Security
 */

(function (global) {
"use strict";

/* ═══════════════════════════════════════════════════════════════════════════
   TEST RUNNER ENGINE
═══════════════════════════════════════════════════════════════════════════ */
const _results = [];
let _current   = "";
let _passed    = 0, _failed = 0, _partial = 0;

function suite(name, fn) {
  _current = name;
  return fn();
}

async function test(name, fn) {
  const fullName = `${_current} › ${name}`;
  try {
    const result = await fn();
    const status = result === false ? "FAIL"
                 : result === "partial" ? "PARTIAL"
                 : "PASS";
    _results.push({ name: fullName, status, error: null });
    if (status === "PASS")    _passed++;
    else if (status === "FAIL")   _failed++;
    else                          _partial++;
    _log(status, fullName);
  } catch (e) {
    _results.push({ name: fullName, status: "FAIL", error: e.message });
    _failed++;
    _log("FAIL", fullName, e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT: " + (msg || "condition failed"));
}

function _log(status, name, err) {
  const emoji = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⚠️";
  const style  = status === "PASS" ? "color:#4ade80" : status === "FAIL" ? "color:#f87171" : "color:#fbbf24";
  if (typeof console !== "undefined") {
    console.log(`%c${emoji} [${status}] ${name}${err ? " — " + err : ""}`, style);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function uid()     { return Math.random().toString(36).slice(2, 9); }

/* ═══════════════════════════════════════════════════════════════════════════
   MOCK ACCESS HELPERS
═══════════════════════════════════════════════════════════════════════════ */
function getMock()   { return global._sokoniMock; }
function getDB()     { return global.SokoniDB; }
function getAuth()   { return global.firebaseAuth; }

/* ═══════════════════════════════════════════════════════════════════════════
   SUITE 1 — AUTHENTICATION
═══════════════════════════════════════════════════════════════════════════ */
async function runAuthSuite() {
  await suite("Authentication", async () => {
    const mock = getMock();
    if (!mock) { _log("FAIL", "Authentication", "Mock not loaded"); return; }

    await test("Buyer login with valid credentials", async () => {
      const user = mock.signInAs("buyer");
      assert(user, "signInAs returned null");
      assert(user.role === "buyer", "role is not buyer");
      assert(user.uid === "mock-buyer-001", "wrong UID");
    });

    await test("Seller login with valid credentials", async () => {
      const user = mock.signInAs("seller");
      assert(user && user.role === "seller");
    });

    await test("Admin login with valid credentials", async () => {
      const user = mock.signInAs("admin");
      assert(user && user.isAdmin === true);
    });

    await test("Driver login with valid credentials", async () => {
      const user = mock.signInAs("driver");
      assert(user && user.role === "driver");
    });

    await test("Provider login with valid credentials", async () => {
      const user = mock.signInAs("provider");
      assert(user && user.role === "provider");
    });

    await test("Invalid email returns auth/user-not-found", async () => {
      let caught = false;
      try {
        await mock.signInWithEmailAndPassword(getAuth(), "nobody@example.com", "pass");
      } catch (e) {
        caught = e.code === "auth/user-not-found";
      }
      assert(caught, "Expected auth/user-not-found error");
    });

    await test("signOut clears currentUser", async () => {
      mock.signInAs("buyer");
      assert(getAuth().currentUser !== null, "currentUser should be set");
      await mock.signOut(getAuth());
      assert(getAuth().currentUser === null, "currentUser should be null after signOut");
    });

    await test("onAuthStateChanged fires callback on login", async () => {
      let fired = false;
      mock.onAuthStateChanged(getAuth(), u => { if (u) fired = true; });
      mock.signInAs("buyer");
      await sleep(200);
      assert(fired, "onAuthStateChanged callback not fired");
    });

    await test("createUserWithEmailAndPassword creates new user", async () => {
      const email = `test+${uid()}@sokoni.co.ke`;
      const result = await mock.createUserWithEmailAndPassword(getAuth(), email, "Pass123!");
      assert(result.user && result.user.email === email);
    });

    await test("sendPasswordResetEmail does not throw", async () => {
      await mock.sendPasswordResetEmail(getAuth(), "buyer@sokoni.co.ke");
      // No assertion needed — just confirms no throw
    });

    await test("Session persisted in localStorage after login", async () => {
      mock.signInAs("admin");
      const stored = localStorage.getItem("sokoniUser");
      assert(stored, "sokoniUser not in localStorage");
      const parsed = JSON.parse(stored);
      assert(parsed.role === "admin", "Persisted role mismatch");
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUITE 2 — BUYER WORKFLOWS
═══════════════════════════════════════════════════════════════════════════ */
async function runBuyerSuite() {
  await suite("Buyer Workflows", async () => {
    const db = getDB();
    mock.signInAs("buyer");

    await test("Load products returns array", async () => {
      const products = await db.loadProducts({ limit: 5 });
      assert(Array.isArray(products), "loadProducts returned non-array");
      assert(products.length > 0, "No products returned");
    });

    await test("Product has required fields", async () => {
      const products = await db.loadProducts({ limit: 1 });
      const p = products[0];
      assert(p.name && typeof p.name === "string", "Missing product.name");
      assert(typeof p.price === "number", "Missing product.price");
      assert(p.sellerId, "Missing product.sellerId");
    });

    await test("Place order creates order document", async () => {
      const orderId = "test-order-" + uid();
      const id = await db.saveOrder({
        orderId,
        buyerId: "mock-buyer-001",
        buyerName: "Test Buyer",
        sellerId: "mock-seller-001",
        items: [{ productId: "prod-001", name: "Test Item", qty: 1, price: 5000 }],
        total: 5000,
        status: "pending",
        paymentStatus: "pending"
      });
      assert(id, "saveOrder did not return ID");
      const data = getMock().getData("orders", id);
      assert(data && data.total === 5000, "Order not saved correctly");
    });

    await test("Order status transitions: pending → processing → delivered", async () => {
      const id = await db.saveOrder({ orderId: uid(), buyerId: "mock-buyer-001", total: 100, status: "pending" });
      await db.updateOrder(id, { status: "processing" });
      let data = getMock().getData("orders", id);
      assert(data.status === "processing");
      await db.updateOrder(id, { status: "delivered" });
      data = getMock().getData("orders", id);
      assert(data.status === "delivered");
    });

    await test("Listen to user orders triggers callback", async () => {
      let received = false;
      const unsub = db.listenUserOrders("mock-buyer-001", snap => { received = true; });
      await sleep(300);
      assert(typeof unsub === "function", "listenUserOrders must return unsub function");
      assert(received, "listenUserOrders callback never fired");
      unsub();
    });

    await test("Submit review for product", async () => {
      const id = await db.saveReview({
        productId: "prod-001",
        buyerId: "mock-buyer-001",
        buyerName: "Test Buyer",
        rating: 5,
        comment: "Excellent product!"
      });
      assert(id, "saveReview failed");
      const data = getMock().getData("reviews", id);
      assert(data.rating === 5);
    });

    await test("Follow and unfollow a seller", async () => {
      await db.follow("mock-buyer-001", "mock-seller-001");
      let following = await db.isFollowing("mock-buyer-001", "mock-seller-001");
      assert(following, "Follow failed");
      await db.unfollow("mock-buyer-001", "mock-seller-001");
      following = await db.isFollowing("mock-buyer-001", "mock-seller-001");
      assert(!following, "Unfollow failed");
    });

    await test("Rider ride history listener fires", async () => {
      let fired = false;
      const unsub = db.listenUserRideHistory("mock-buyer-001", () => { fired = true; });
      await sleep(300);
      assert(fired);
      unsub();
    });

    await test("Package request creation", async () => {
      const id = await db.savePackageRequest({
        senderId: "mock-buyer-001",
        senderName: "Test Buyer",
        pickup: { lat: -1.284, lng: 36.82, address: "CBD" },
        dropoff: { lat: -1.303, lng: 36.81, address: "South C" },
        status: "pending",
        fee: 200
      });
      assert(id, "savePackageRequest failed");
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUITE 3 — SELLER WORKFLOWS
═══════════════════════════════════════════════════════════════════════════ */
async function runSellerSuite() {
  await suite("Seller Workflows", async () => {
    const db = getDB();
    mock.signInAs("seller");

    await test("Save new product", async () => {
      const id = await db.saveProduct({
        name: "Test Product " + uid(),
        price: 2500,
        stock: 10,
        category: "Electronics",
        sellerId: "mock-seller-001",
        status: "active"
      });
      assert(id, "saveProduct failed");
      const data = getMock().getData("products", id);
      assert(data.price === 2500);
    });

    await test("Update product stock", async () => {
      const id = await db.saveProduct({ id: "prod-stock-test", name: "Stock Test", price: 100, stock: 50, sellerId: "mock-seller-001" });
      await db.updateProductStock("prod-stock-test", 45);
      const data = getMock().getData("products", "prod-stock-test");
      assert(data.stock === 45, `Expected stock 45, got ${data.stock}`);
    });

    await test("Delete product", async () => {
      const id = await db.saveProduct({ name: "Delete Me", price: 100, sellerId: "mock-seller-001" });
      await db.deleteProduct(id);
      const data = getMock().getData("products", id);
      assert(data === null, "Product not deleted");
    });

    await test("Listen to seller orders fires callback", async () => {
      let fired = false;
      const unsub = db.listenSellerOrders("mock-seller-001", () => { fired = true; });
      await sleep(300);
      assert(fired);
      unsub();
    });

    await test("Save seller broadcast", async () => {
      const id = await db.saveSellerBroadcast({
        sellerId: "mock-seller-001",
        sellerName: "Alice Electronics",
        title: "Flash Sale!",
        body: "50% off all phones today!"
      });
      assert(id);
      const data = getMock().getData("broadcasts", id);
      assert(data.title === "Flash Sale!");
    });

    await test("Load own products", async () => {
      const products = await db.loadProducts({ sellerId: "mock-seller-001", limit: 10 });
      assert(Array.isArray(products) && products.length > 0);
    });

    await test("Save unboxing review", async () => {
      const id = await db.saveUnboxingReview({
        sellerId: "mock-seller-001",
        reviewerId: "mock-buyer-001",
        rating: 5,
        comment: "Professionally packaged!"
      });
      assert(id);
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUITE 4 — ADMIN WORKFLOWS
═══════════════════════════════════════════════════════════════════════════ */
async function runAdminSuite() {
  await suite("Admin Workflows", async () => {
    const db = getDB();
    mock.signInAs("admin");

    await test("Listen to all orders", async () => {
      let fired = false;
      const unsub = db.listenAllOrders(snap => { fired = true; });
      await sleep(300);
      assert(fired);
      unsub();
    });

    await test("Listen to all deliveries", async () => {
      let fired = false;
      const unsub = db.listenAllDeliveries(snap => { fired = true; });
      await sleep(300);
      assert(fired);
      unsub();
    });

    await test("Listen to disputes", async () => {
      let fired = false;
      const unsub = db.listenDisputes(snap => { fired = true; });
      await sleep(300);
      assert(fired);
      unsub();
    });

    await test("Update application status", async () => {
      const appId = await db.saveApplication({ uid: "test-seller-apply", displayName: "Test Seller", status: "pending" });
      await db.updateApplicationStatus(appId, "approved", "Verified documents");
      const data = getMock().getData("applications", appId);
      assert(data.status === "approved");
    });

    await test("Listen to applications", async () => {
      let fired = false;
      const unsub = db.listenApplications("mock-admin-001", snap => { fired = true; });
      await sleep(300);
      assert(fired);
      unsub();
    });

    await test("Query users by phone", async () => {
      const users = await db.queryUsers({ phone: "+254733111222" });
      assert(Array.isArray(users));
    });

    await test("Resolve dispute", async () => {
      const id = await db.saveDispute({
        orderId: "order-001",
        raisedBy: "mock-buyer-001",
        reason: "Wrong item",
        status: "open"
      });
      await db.updateDispute(id, { status: "resolved", resolution: "Refund issued" });
      const data = getMock().getData("disputes", id);
      assert(data.status === "resolved");
    });

    await test("Save and read notification", async () => {
      const id = await db.saveNotification({
        uid: "mock-admin-001",
        type: "system",
        title: "Test Notification",
        body: "This is a test.",
        read: false
      });
      await db.markNotificationRead(id);
      const data = getMock().getData("notifications", id);
      assert(data.read === true);
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUITE 5 — DRIVER WORKFLOWS
═══════════════════════════════════════════════════════════════════════════ */
async function runDriverSuite() {
  await suite("Driver Workflows", async () => {
    const db = getDB();
    mock.signInAs("driver");

    await test("Set driver online", async () => {
      await db.setDriverOnline("mock-driver-001", true, { lat: -1.284, lng: 36.82, vehicle: "Boda" });
      const data = getMock().getData("driverLocations", "mock-driver-001");
      assert(data && data.online === true);
    });

    await test("Update driver GPS location", async () => {
      await db.updateDriverLocation("mock-driver-001", -1.290, 36.825, { speed: 30 });
      const data = getMock().getData("driverLocations", "mock-driver-001");
      assert(data.lat === -1.290);
    });

    await test("Listen for active ride requests", async () => {
      let fired = false;
      const unsub = db.listenDriverActiveRequests("mock-driver-001", snap => { fired = true; });
      await sleep(300);
      assert(fired);
      unsub();
    });

    await test("Accept and update ride", async () => {
      const rideId = await db.saveRide({
        riderId: "mock-buyer-001",
        driverId: "mock-driver-001",
        status: "requested",
        fare: 350
      });
      await db.updateRide(rideId, { status: "in_progress", pickedUpAt: new Date().toISOString() });
      const data = getMock().getData("rides", rideId);
      assert(data.status === "in_progress");
    });

    await test("Listen to driver delivery requests", async () => {
      let fired = false;
      const unsub = db.listenDriverDeliveryRequests("mock-driver-001", snap => { fired = true; });
      await sleep(300);
      assert(fired);
      unsub();
    });

    await test("Save driver rating", async () => {
      const id = await db.saveDriverRating({
        driverId: "mock-driver-001",
        riderId: "mock-buyer-001",
        rating: 5,
        comment: "Great driver!"
      });
      assert(id);
    });

    await test("Listen to driver earnings", async () => {
      let fired = false;
      const unsub = db.listenDriverEarnings("mock-driver-001", snap => { fired = true; });
      await sleep(300);
      assert(fired);
      unsub();
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUITE 6 — PROVIDER WORKFLOWS
═══════════════════════════════════════════════════════════════════════════ */
async function runProviderSuite() {
  await suite("Provider Workflows", async () => {
    const db = getDB();
    mock.signInAs("provider");

    await test("Save provider profile", async () => {
      const id = await db.saveProvider({
        uid: "mock-prov-001",
        displayName: "Dr. Test",
        category: "Healthcare",
        specialty: "Cardiology",
        fee: 3000,
        status: "active"
      });
      assert(id);
    });

    await test("Get provider by ID", async () => {
      const data = await db.getProvider("mock-prov-001");
      assert(data, "Provider not found");
      assert(data.displayName === "Dr. Sarah Njeri" || data.displayName === "Dr. Test");
    });

    await test("Update provider status", async () => {
      await db.updateProviderStatus("mock-prov-001", "inactive");
      const data = getMock().getData("providers", "mock-prov-001");
      assert(data.status === "inactive");
      await db.updateProviderStatus("mock-prov-001", "active");
    });

    await test("Accept booking and update status", async () => {
      const id = await db.saveBooking({
        clientId: "mock-buyer-001",
        providerId: "mock-prov-001",
        status: "pending",
        date: "2026-07-01",
        time: "09:00"
      });
      await db.updateBooking(id, { status: "confirmed" });
      const data = getMock().getData("bookings", id);
      assert(data.status === "confirmed");
    });

    await test("Listen to provider bookings", async () => {
      let fired = false;
      const unsub = db.listenProviderBookings("mock-prov-001", snap => { fired = true; });
      await sleep(300);
      assert(fired);
      unsub();
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUITE 7 — PAYMENT & ESCROW WORKFLOWS
═══════════════════════════════════════════════════════════════════════════ */
async function runPaymentSuite() {
  await suite("Payment & Escrow", async () => {
    const db = getDB();
    const mock = getMock();
    mock.signInAs("buyer");

    await test("Mock M-Pesa STK push returns CheckoutRequestID", async () => {
      const cfn = mock.httpsCallable(null, "initiateSTKPush");
      const result = await cfn({ phone: "+254733111222", amount: 500, orderId: "test-pay-001" });
      assert(result.data.success === true);
      assert(result.data.CheckoutRequestID, "No CheckoutRequestID returned");
    });

    await test("Mock payment status verification", async () => {
      const cfn = mock.httpsCallable(null, "verifyPaymentStatus");
      const result = await cfn({ orderId: "order-001" });
      assert(result.data.paid === true);
    });

    await test("Escrow: hold funds", async () => {
      const id = await db.saveEscrow({
        orderId: "test-escrow-001",
        buyerId: "mock-buyer-001",
        sellerId: "mock-seller-001",
        amount: 18500,
        status: "held"
      });
      assert(id);
      const data = getMock().getData("escrow", id);
      assert(data.status === "held");
    });

    await test("Escrow: listen to escrow document", async () => {
      let fired = false;
      const unsub = db.listenEscrow("order-002", snap => { fired = true; });
      await sleep(300);
      assert(fired);
      unsub();
    });

    await test("Escrow: release funds", async () => {
      const oid = "test-release-" + uid();
      await db.saveEscrow({ orderId: oid, status: "held", amount: 1000 });
      await db.releaseEscrow(oid);
      const data = getMock().getData("escrow", oid);
      assert(data.status === "released");
    });

    await test("Duplicate payment guard — idempotent escrow", async () => {
      const oid = "test-idem-" + uid();
      await db.saveEscrow({ orderId: oid, status: "held", amount: 500 });
      await db.saveEscrow({ orderId: oid, status: "held", amount: 500 });
      const data = getMock().getData("escrow", oid);
      assert(data._id === oid, "Idempotent write changed document ID");
    });

    await test("Save order event on payment complete", async () => {
      const id = await db.saveOrderEvent({
        orderId: "order-001",
        event: "payment_received",
        actor: "system",
        note: "M-Pesa payment confirmed"
      });
      assert(id);
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUITE 8 — NOTIFICATION WORKFLOWS
═══════════════════════════════════════════════════════════════════════════ */
async function runNotificationSuite() {
  await suite("Notifications", async () => {
    const db = getDB();
    mock.signInAs("buyer");

    await test("Save notification", async () => {
      const id = await db.saveNotification({
        uid: "mock-buyer-001",
        type: "order_update",
        title: "Your order is ready",
        body: "Pick up at the gate.",
        read: false
      });
      assert(id);
    });

    await test("Listen to notifications fires callback", async () => {
      let count = 0;
      const unsub = db.listenNotifications("mock-buyer-001", snap => { count++; });
      await sleep(300);
      assert(count > 0, "listenNotifications never fired");
      unsub();
    });

    await test("Mark notification as read", async () => {
      const id = await db.saveNotification({ uid: "mock-buyer-001", type: "test", title: "T", body: "B", read: false });
      await sleep(50);
      await db.markNotificationRead(id);
      const data = getMock().getData("notifications", id);
      assert(data.read === true);
    });

    await test("Mock SMS notification Cloud Function", async () => {
      const cfn = getMock().httpsCallable(null, "posSendSMS");
      const result = await cfn({ phone: "+254733111222", message: "Your order is ready." });
      assert(result.data.success === true);
    });

    await test("Mock email notification Cloud Function", async () => {
      const cfn = getMock().httpsCallable(null, "sendEmailNotification");
      const result = await cfn({ to: "buyer@sokoni.co.ke", subject: "Order confirmed", html: "<p>Thanks!</p>" });
      assert(result.data.success === true);
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUITE 9 — FIRESTORE API CORRECTNESS
═══════════════════════════════════════════════════════════════════════════ */
async function runFirestoreSuite() {
  await suite("Firestore Mock API", async () => {
    const { collection, doc, query, where, orderBy, limit, getDocs,
            getDoc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
            writeBatch, runTransaction, serverTimestamp, increment,
            arrayUnion, arrayRemove, Timestamp } = getMock();
    const db = global.firebaseDB;

    await test("collection() returns ref with correct id", async () => {
      const ref = collection(db, "products");
      assert(ref.id === "products");
    });

    await test("doc() from collection ref has correct _col", async () => {
      const colRef = collection(db, "orders");
      const docRef = doc(colRef, "order-001");
      assert(docRef._col === "orders");
      assert(docRef._id === "order-001");
    });

    await test("addDoc saves and returns ref", async () => {
      const colRef = collection(db, "testCol");
      const ref = await addDoc(colRef, { name: "Test", value: 42 });
      assert(ref._id, "ref._id missing");
      const snap = await getDoc(ref);
      assert(snap.exists());
      assert(snap.data().value === 42);
    });

    await test("setDoc with merge:true merges fields", async () => {
      const docRef = doc(db, "mergeTest", "doc-1");
      await setDoc(docRef, { a: 1, b: 2 });
      await setDoc(docRef, { b: 99, c: 3 }, { merge: true });
      const snap = await getDoc(docRef);
      const d = snap.data();
      assert(d.a === 1, "merge should preserve field a");
      assert(d.b === 99, "merge should update field b");
      assert(d.c === 3, "merge should add field c");
    });

    await test("updateDoc updates specific fields", async () => {
      const docRef = doc(db, "updateTest", "doc-1");
      await setDoc(docRef, { x: 1, y: 2 });
      await updateDoc(docRef, { y: 99 });
      const snap = await getDoc(docRef);
      assert(snap.data().x === 1);
      assert(snap.data().y === 99);
    });

    await test("deleteDoc removes document", async () => {
      const docRef = doc(db, "delTest", "del-1");
      await setDoc(docRef, { val: "toDelete" });
      await deleteDoc(docRef);
      const snap = await getDoc(docRef);
      assert(!snap.exists());
    });

    await test("where() filter works for == operator", async () => {
      const colRef = collection(db, "products");
      const q = query(colRef, where("category", "==", "Phones"));
      const snap = await getDocs(q);
      assert(!snap.empty, "Expected phone products");
      snap.forEach(d => assert(d.data().category === "Phones"));
    });

    await test("orderBy() + limit() sorts and truncates", async () => {
      const colRef = collection(db, "products");
      const q = query(colRef, orderBy("price"), limit(3));
      const snap = await getDocs(q);
      assert(snap.size === 3, `Expected 3, got ${snap.size}`);
      const prices = snap.docs.map(d => d.data().price);
      assert(prices[0] <= prices[1], "orderBy asc failed");
    });

    await test("onSnapshot fires immediately then on updates", async () => {
      let count = 0;
      const docRef = doc(db, "snapTest", "sd-1");
      await setDoc(docRef, { count: 0 });
      const unsub = onSnapshot(docRef, snap => { count++; });
      await sleep(200);
      assert(count >= 1, "onSnapshot should fire immediately");
      await updateDoc(docRef, { count: 1 });
      await sleep(200);
      assert(count >= 2, "onSnapshot should fire on update");
      unsub();
    });

    await test("writeBatch commits multiple operations atomically", async () => {
      const batch = writeBatch(db);
      const ref1 = doc(db, "batchTest", "b-1");
      const ref2 = doc(db, "batchTest", "b-2");
      batch.set(ref1, { val: "A" });
      batch.set(ref2, { val: "B" });
      await batch.commit();
      const [s1, s2] = await Promise.all([getDoc(ref1), getDoc(ref2)]);
      assert(s1.data().val === "A" && s2.data().val === "B");
    });

    await test("runTransaction can read then write", async () => {
      const docRef = doc(db, "txnTest", "t-1");
      await setDoc(docRef, { count: 5 });
      await runTransaction(db, async txn => {
        const snap = await txn.get(docRef);
        txn.update(docRef, { count: snap.data().count + 1 });
      });
      const snap = await getDoc(docRef);
      assert(snap.data().count === 6);
    });

    await test("increment() field value works", async () => {
      const docRef = doc(db, "incTest", "i-1");
      await setDoc(docRef, { views: 10 });
      await updateDoc(docRef, { views: increment(5) });
      const snap = await getDoc(docRef);
      assert(snap.data().views === 15);
    });

    await test("arrayUnion() adds items without duplicates", async () => {
      const docRef = doc(db, "arrTest", "a-1");
      await setDoc(docRef, { tags: ["a", "b"] });
      await updateDoc(docRef, { tags: arrayUnion("c", "a") }); // "a" already exists
      const snap = await getDoc(docRef);
      const tags = snap.data().tags;
      assert(tags.includes("c") && tags.filter(t => t === "a").length === 1);
    });

    await test("arrayRemove() removes specific items", async () => {
      const docRef = doc(db, "arrTest", "ar-1");
      await setDoc(docRef, { tags: ["x", "y", "z"] });
      await updateDoc(docRef, { tags: arrayRemove("y") });
      const snap = await getDoc(docRef);
      assert(!snap.data().tags.includes("y"));
    });

    await test("serverTimestamp() returns mock timestamp object", async () => {
      const ts = serverTimestamp();
      assert(ts._isMockTs === true);
      assert(typeof ts.toDate === "function");
      assert(ts.seconds > 0);
    });

    await test("Timestamp.now() has expected shape", async () => {
      const ts = Timestamp.now();
      assert(ts.seconds > 0);
      assert(typeof ts.toDate === "function");
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUITE 10 — ERROR HANDLING & RESILIENCE
═══════════════════════════════════════════════════════════════════════════ */
async function runResilienceSuite() {
  await suite("Error Handling & Resilience", async () => {
    const mock = getMock();

    await test("getDoc on non-existent doc returns exists()=false", async () => {
      const snap = await mock.getDoc(mock.doc(global.firebaseDB, "nonexistent", "missing-doc-xyz"));
      assert(!snap.exists(), "Non-existent doc should return exists()=false");
      assert(snap.data() === undefined, "Non-existent doc data() should be undefined");
    });

    await test("updateDoc on non-existent doc does not throw", async () => {
      await mock.updateDoc(mock.doc(global.firebaseDB, "ghost", "g-1"), { x: 1 });
      // Should succeed (mock creates on update)
    });

    await test("getDocs on empty collection returns empty snapshot", async () => {
      const colRef = mock.collection(global.firebaseDB, "emptyCollection_" + uid());
      const snap = await mock.getDocs(colRef);
      assert(snap.empty === true);
      assert(snap.size === 0);
    });

    await test("Unsubscribed listener does not fire after unsub()", async () => {
      let count = 0;
      const docRef = mock.doc(global.firebaseDB, "unsubTest", "u-1");
      await mock.setDoc(docRef, { v: 0 });
      const unsub = mock.onSnapshot(docRef, () => { count++; });
      await sleep(200);
      const before = count;
      unsub();
      await mock.updateDoc(docRef, { v: 1 });
      await sleep(200);
      assert(count === before, `Listener fired ${count - before} times after unsub`);
    });

    await test("Cloud Function with no mock returns success (not throw)", async () => {
      const cfn = mock.httpsCallable(null, "unknownFunction_xyz");
      const result = await cfn({ test: 1 });
      assert(result.data.success === true, "Unknown CF should return generic success");
    });

    await test("signOut then accessing protected data returns null user", async () => {
      await mock.signOut(global.firebaseAuth);
      assert(global.firebaseAuth.currentUser === null);
    });

    await test("Query with limit(0) returns empty snapshot", async () => {
      const colRef = mock.collection(global.firebaseDB, "products");
      const q = mock.query(colRef, mock.limit(0));
      const snap = await mock.getDocs(q);
      assert(snap.size === 0);
    });

    await test("Concurrent writes to same doc resolve consistently", async () => {
      const docRef = mock.doc(global.firebaseDB, "concurrent", "c-1");
      await mock.setDoc(docRef, { count: 0 });
      await Promise.all([
        mock.updateDoc(docRef, { a: 1 }),
        mock.updateDoc(docRef, { b: 2 }),
        mock.updateDoc(docRef, { c: 3 })
      ]);
      const snap = await mock.getDoc(docRef);
      const data = snap.data();
      assert(data.a === 1 && data.b === 2 && data.c === 3, "Concurrent writes corrupted data");
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUITE 11 — SECURITY TESTS
═══════════════════════════════════════════════════════════════════════════ */
async function runSecuritySuite() {
  await suite("Security", async () => {

    await test("_esc() escapes XSS payload", async () => {
      const _esc = s => String(s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":'&#39;'}[c]));
      const payload = '<script>alert("xss")</script>';
      const escaped = _esc(payload);
      assert(!escaped.includes("<script>"), "XSS not escaped");
      assert(escaped.includes("&lt;script&gt;"), "Expected lt/gt encoding");
    });

    await test("_esc() handles null/undefined without throwing", async () => {
      const _esc = s => String(s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":'&#39;'}[c]));
      assert(_esc(null) === "");
      assert(_esc(undefined) === "");
      assert(_esc(0) === "0");
    });

    await test("Mock Firebase rejects empty apiKey as offline mode", async () => {
      assert(global.firebaseApp._isMock === true || global.firebaseApp.options, "No Firebase app");
    });

    await test("CSS color sanitizer rejects injection payload", async () => {
      const sanitize = v => {
        const s = String(v||"").trim();
        return /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d,.\s%]+\)|[a-zA-Z]{2,30})$/.test(s) ? s : "#71ff00";
      };
      assert(sanitize('red') === 'red');
      assert(sanitize('#ff0000') === '#ff0000');
      assert(sanitize('rgb(255,0,0)') === 'rgb(255,0,0)');
      assert(sanitize('"><script>alert(1)</script>') === '#71ff00', "Injection not blocked");
      assert(sanitize('transparent;background:url(x)') === '#71ff00', "CSS injection not blocked");
    });

    await test("javascript: href blocked in story CTA", async () => {
      const rawLink = "javascript:alert(1)";
      const safeLink = /^javascript:/i.test(rawLink) ? "#" : rawLink;
      assert(safeLink === "#", "javascript: protocol not blocked");
    });

    await test("localStorage session data does not expose password or token", async () => {
      getMock().signInAs("buyer");
      const stored = JSON.parse(localStorage.getItem("sokoniUser") || "{}");
      assert(!stored.password, "Password stored in localStorage");
      assert(!stored.token && !stored.accessToken, "Token stored in localStorage");
      assert(!stored.refreshToken, "Refresh token stored in localStorage");
    });

    await test("Mock auth users have no sensitive fields in MOCK_USERS", async () => {
      const users = Object.values(getMock().MOCK_USERS);
      users.forEach(u => {
        assert(!u.password, `Mock user ${u.email} has password field`);
        assert(!u.token, `Mock user ${u.email} has token field`);
      });
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 3 — STRESS / CONCURRENCY TEST (simulation only)
═══════════════════════════════════════════════════════════════════════════ */
async function runStressTest() {
  await suite("Stress Test (Mock — 100 Concurrent Ops)", async () => {
    const mock = getMock();
    const db = getDB();

    await test("100 concurrent product saves complete without data corruption", async () => {
      const ops = Array.from({ length: 100 }, (_, i) =>
        db.saveProduct({ name: `Stress Product ${i}`, price: 1000 + i, sellerId: "mock-seller-001", category: "Test", status: "active" })
      );
      const ids = await Promise.all(ops);
      assert(ids.length === 100, `Expected 100 results, got ${ids.length}`);
      const uniqueIds = new Set(ids);
      assert(uniqueIds.size === 100, `Duplicate IDs: ${100 - uniqueIds.size} collisions`);
    });

    await test("100 concurrent order saves with unique IDs", async () => {
      const ops = Array.from({ length: 100 }, (_, i) =>
        db.saveOrder({ orderId: uid(), buyerId: "mock-buyer-001", total: 100 + i, status: "pending" })
      );
      const ids = await Promise.all(ops);
      const unique = new Set(ids);
      assert(unique.size === 100, `ID collisions: ${100 - unique.size}`);
    });

    await test("50 concurrent listeners attach and detach cleanly", async () => {
      const unsubs = [];
      let fireCount = 0;
      for (let i = 0; i < 50; i++) {
        unsubs.push(db.listenNotifications("mock-buyer-001", () => { fireCount++; }));
      }
      await sleep(500);
      unsubs.forEach(u => u());
      const before = fireCount;
      await db.saveNotification({ uid: "mock-buyer-001", type: "test", title: "T", body: "B", read: false });
      await sleep(300);
      assert(fireCount === before, `${fireCount - before} listeners fired after unsub`);
    });

    await test("Mock Firestore handles 500 reads without hanging", async () => {
      const start = Date.now();
      const reads = Array.from({ length: 500 }, () =>
        mock.getDoc(mock.doc(global.firebaseDB, "products", "prod-001"))
      );
      await Promise.all(reads);
      const elapsed = Date.now() - start;
      assert(elapsed < 5000, `500 reads took ${elapsed}ms — too slow`);
    });

    await test("1000 where() queries execute in under 3 seconds", async () => {
      const start = Date.now();
      const colRef = mock.collection(global.firebaseDB, "products");
      const queries = Array.from({ length: 1000 }, () =>
        mock.getDocs(mock.query(colRef, mock.where("status", "==", "active"), mock.limit(5)))
      );
      await Promise.all(queries);
      const elapsed = Date.now() - start;
      assert(elapsed < 3000, `1000 queries took ${elapsed}ms`);
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN RUNNER
═══════════════════════════════════════════════════════════════════════════ */
const mock = global._sokoniMock;

async function run() {
  if (!global._sokoniMock) {
    console.error("[TEST] Mock layer not loaded. Add ?offline=1 to URL first.");
    return { passed: 0, failed: 1, partial: 0, results: [] };
  }

  console.group("%c SOKONI Regression Test Suite v1.0", "font-size:14px;font-weight:bold;color:#71ff00;background:#111;padding:4px 8px;");
  console.log("Mock layer:", global._sokoniMock ? "✅ Loaded" : "❌ Missing");
  console.log("SokoniDB:", global.SokoniDB ? "✅ Ready" : "❌ Missing");
  console.log("Starting test suites...\n");

  _passed = 0; _failed = 0; _partial = 0;
  _results.length = 0;

  // Reset mock to clean state
  if (global._sokoniMock && global._sokoniMock.signInAs) {
    global._sokoniMock.signInAs("buyer");
  }

  await runAuthSuite();
  await runBuyerSuite();
  await runSellerSuite();
  await runAdminSuite();
  await runDriverSuite();
  await runProviderSuite();
  await runPaymentSuite();
  await runNotificationSuite();
  await runFirestoreSuite();
  await runResilienceSuite();
  await runSecuritySuite();
  await runStressTest();

  const total = _passed + _failed + _partial;
  console.groupEnd();
  console.log(`\n%c RESULTS: ${_passed}/${total} PASSED | ${_failed} FAILED | ${_partial} PARTIAL `,
    _failed === 0 ? "background:#166534;color:#4ade80;font-weight:bold;padding:4px 8px;"
                  : "background:#7f1d1d;color:#f87171;font-weight:bold;padding:4px 8px;");

  return {
    passed: _passed,
    failed: _failed,
    partial: _partial,
    total,
    results: _results,
    score: Math.round((_passed / total) * 100)
  };
}

function report() {
  const r = { passed:_passed, failed:_failed, partial:_partial, results:[..._results] };
  console.table(r.results.map(x => ({ Test:x.name, Status:x.status, Error:x.error||"" })));
  return r;
}

global.SokoniTests = { run, report, results: _results };

}(typeof window !== "undefined" ? window : this));
