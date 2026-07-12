/* ============================================================
   SOKONI Email Trigger Cloud Functions  v1.0
   Auto-fires on Firestore / Auth events to send transactional email.
   NOTE: Does NOT duplicate onOrderStatusChange / onOrderConfirmed /
         onDeliveryStatusChange / onRideStatusChange (already in index.js).
============================================================ */
"use strict";

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule }    = require("firebase-functions/v2/scheduler");
const { onRequest }     = require("firebase-functions/v2/https");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { beforeUserCreated } = require("firebase-functions/v2/identity");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const emailSvc = require("./email-service");
const { getTemplate } = require("./email-templates");
const { EMAIL_SECRETS } = emailSvc;
const { assertAuth } = require("./shared/errors");

const SENDGRID_WEBHOOK_KEY = defineSecret("SENDGRID_WEBHOOK_KEY");

/* ── Helper: render template + queue ──────────────────────── */
async function trigger(templateName, data, extraPayload = {}) {
  let tmpl;
  try {
    tmpl = getTemplate(templateName, data);
  } catch (e) {
    console.error(`[EmailTrigger] Unknown template "${templateName}":`, e.message);
    return;
  }
  return emailSvc.sendOrQueue({
    to:       extraPayload.to   || data.email,
    subject:  tmpl.subject,
    html:     tmpl.html,
    text:     tmpl.text,
    from:     tmpl.from,
    category: tmpl.category,
    template: templateName,
    uid:      extraPayload.uid  || data.uid || "",
    emailId:  extraPayload.emailId || "",
    ...extraPayload,
  }, false /* queue, not immediate */);
}

/* ── Helper: get user email from Auth by uid ──────────────── */
async function emailForUid(uid) {
  try {
    const u = await admin.auth().getUser(uid);
    return u.email || "";
  } catch { return ""; }
}

/* ═══════════════════════════════════════════════════════════
   AUTH: Welcome email on first sign-up
═══════════════════════════════════════════════════════════ */
exports.emailOnUserCreate = onDocumentCreated(
  { document: "users/{uid}", secrets: EMAIL_SECRETS },
  async (event) => {
    const uid  = event.params.uid;
    const data = event.data?.data() || {};
    const email = data.email || await emailForUid(uid);
    if (!email) return;
    await trigger("welcome", { name: data.displayName || data.name || "there", email }, {
      uid, emailId: `welcome-${uid}`,
    });
  }
);

/* ═══════════════════════════════════════════════════════════
   SELLER: Approval / rejection
═══════════════════════════════════════════════════════════ */
exports.emailOnSellerStatusChange = onDocumentUpdated(
  { document: "sellers/{sellerId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return;
    const email = after.email || await emailForUid(after.uid || "");
    if (!email) return;
    const d = {
      name:        after.displayName || after.storeName || "Seller",
      storeName:   after.storeName || "",
      accountType: after.accountType || "Seller",
      commission:  after.commissionRate ? `${after.commissionRate}%` : "Standard",
      reason:      after.rejectionReason || "",
      email,
    };
    if (after.status === "approved") await trigger("seller-approved", d, { uid: after.uid || "", emailId: `seller-approved-${event.params.sellerId}` });
    else if (after.status === "rejected") await trigger("seller-rejected", d, { uid: after.uid || "", emailId: `seller-rejected-${event.params.sellerId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   PRODUCT: Approval / rejection
═══════════════════════════════════════════════════════════ */
exports.emailOnProductStatusChange = onDocumentUpdated(
  { document: "products/{productId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status) return;
    const sellerEmail = after.sellerEmail || await emailForUid(after.sellerId || "");
    if (!sellerEmail) return;
    const d = {
      name:        after.sellerName || "Seller",
      productName: after.name || after.title || "",
      productId:   event.params.productId,
      category:    after.category || "",
      price:       after.price || 0,
      reason:      after.rejectionReason || "",
      email:       sellerEmail,
    };
    if (after.status === "approved") await trigger("product-approved", d, { uid: after.sellerId || "", emailId: `product-approved-${event.params.productId}` });
    else if (after.status === "rejected") await trigger("product-rejected", d, { uid: after.sellerId || "", emailId: `product-rejected-${event.params.productId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   PAYMENTS: Successful payment
═══════════════════════════════════════════════════════════ */
exports.emailOnPaymentSuccess = onDocumentCreated(
  { document: "payments/{paymentId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const p = event.data?.data() || {};
    if (p.status !== "completed" && p.status !== "success") return;
    const email = p.email || await emailForUid(p.uid || "");
    if (!email) return;
    await trigger("payment-success", {
      name:   p.customerName || "Customer",
      amount: p.amount || 0,
      ref:    p.reference || event.params.paymentId,
      method: p.method || "M-Pesa",
      date:   p.createdAt?.toDate?.()?.toLocaleDateString("en-KE") || "",
      email,
    }, { uid: p.uid || "", emailId: `payment-${event.params.paymentId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   PAYMENTS: Payout to seller
═══════════════════════════════════════════════════════════ */
exports.emailOnSellerPayout = onDocumentCreated(
  { document: "payouts/{payoutId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const p = event.data?.data() || {};
    const email = p.email || await emailForUid(p.uid || "");
    if (!email) return;
    await trigger("seller-payout", {
      name:      p.sellerName || "Seller",
      amount:    p.amount || 0,
      phone:     p.phone || "",
      mpesaRef:  p.mpesaRef || "",
      date:      p.createdAt?.toDate?.()?.toLocaleDateString("en-KE") || "",
      email,
    }, { uid: p.uid || "", emailId: `payout-${event.params.payoutId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   SUBSCRIPTIONS: Renewal + expiry reminder handled by scheduler
═══════════════════════════════════════════════════════════ */
exports.emailOnSubscriptionRenewal = onDocumentUpdated(
  { document: "subscriptions/{subId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    /* Only fire when status flips from inactive/expired → active */
    if (before.status === "active" || after.status !== "active") return;
    const email = after.email || await emailForUid(after.uid || "");
    if (!email) return;
    await trigger("subscription-renewal", {
      name:     after.displayName || "User",
      plan:     after.plan || "SOKONI Plan",
      amount:   after.amount || 0,
      nextDate: after.expiresAt?.toDate?.()?.toLocaleDateString("en-KE") || "",
      email,
    }, { uid: after.uid || "", emailId: `sub-renewal-${event.params.subId}-${Date.now()}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   DISPUTES: Open + resolution
═══════════════════════════════════════════════════════════ */
exports.emailOnDisputeCreate = onDocumentCreated(
  { document: "disputes/{disputeId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const d = event.data?.data() || {};
    const email = d.customerEmail || await emailForUid(d.customerId || "");
    if (!email) return;
    await trigger("dispute-opened", {
      name:       d.customerName || "Customer",
      orderId:    d.orderId || "",
      disputeId:  event.params.disputeId,
      reason:     d.reason || "",
      email,
    }, { uid: d.customerId || "", emailId: `dispute-open-${event.params.disputeId}` });
  }
);

exports.emailOnDisputeResolved = onDocumentUpdated(
  { document: "disputes/{disputeId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status || after.status !== "resolved") return;
    const email = after.customerEmail || await emailForUid(after.customerId || "");
    if (!email) return;
    await trigger("dispute-resolved", {
      name:         after.customerName || "Customer",
      orderId:      after.orderId || "",
      resolution:   after.resolution || "See dispute details",
      refundAmount: after.refundAmount || 0,
      email,
    }, { uid: after.customerId || "", emailId: `dispute-resolved-${event.params.disputeId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   DELIVERY: Dispatch → driver assigned → on way → nearby
   NOTE: onDeliveryStatusChange already in index.js handles basic status changes.
   These triggers fire on dedicated dispatch / tracking collections.
═══════════════════════════════════════════════════════════ */

/* When a delivery is created (dispatched) */
exports.emailOnDeliveryCreate = onDocumentCreated(
  { document: "deliveries/{deliveryId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const d = event.data?.data() || {};
    const email = d.customerEmail || await emailForUid(d.customerId || "");
    if (!email) return;
    const deliveryId = event.params.deliveryId;
    /* Queue the dispatch email + live tracking link */
    await trigger("delivery-dispatched", {
      name:       d.customerName || "Customer",
      orderId:    d.orderId || deliveryId,
      deliveryId,
      eta:        d.eta || "",
      email,
    }, { uid: d.customerId || "", emailId: `delivery-dispatched-${deliveryId}` });

    await trigger("live-tracking-link", {
      name:       d.customerName || "Customer",
      orderId:    d.orderId || deliveryId,
      deliveryId,
      driverName: d.driverName || "",
      eta:        d.eta || "",
      email,
    }, { uid: d.customerId || "", emailId: `tracking-link-${deliveryId}` });
  }
);

/* When a driver is assigned to a delivery */
exports.emailOnDriverAssigned = onDocumentUpdated(
  { document: "deliveries/{deliveryId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    const deliveryId = event.params.deliveryId;

    /* Driver just assigned */
    if (!before.driverId && after.driverId) {
      const email = after.customerEmail || await emailForUid(after.customerId || "");
      if (email) {
        await trigger("driver-assigned", {
          name:        after.customerName || "Customer",
          orderId:     after.orderId || deliveryId,
          deliveryId,
          driverName:  after.driverName || "Your driver",
          driverPhone: after.driverPhone || "",
          vehicle:     after.vehicle || "Motorcycle",
          plate:       after.plate || "",
          eta:         after.eta || "",
          email,
        }, { uid: after.customerId || "", emailId: `driver-assigned-${deliveryId}` });
      }

      /* Also notify driver of their new job */
      const driverEmail = after.driverEmail || await emailForUid(after.driverId || "");
      if (driverEmail) {
        await trigger("driver-new-job", {
          driverName: after.driverName || "Driver",
          orderId:    after.orderId || deliveryId,
          pickup:     after.pickupAddress || "See app",
          dropoff:    after.dropoffAddress || "See app",
          distance:   after.distanceKm ? `${after.distanceKm} km` : "",
          earnings:   after.driverEarnings || 0,
          email:      driverEmail,
        }, { uid: after.driverId || "", emailId: `driver-job-${deliveryId}` });
      }
    }

    /* Status → on_the_way */
    if (before.status !== after.status && after.status === "on_the_way") {
      const email = after.customerEmail || await emailForUid(after.customerId || "");
      if (email) {
        await trigger("driver-on-way", {
          name:        after.customerName || "Customer",
          orderId:     after.orderId || deliveryId,
          deliveryId,
          driverName:  after.driverName || "Your driver",
          driverPhone: after.driverPhone || "",
          eta:         after.eta || "",
          address:     after.dropoffAddress || "",
          email,
        }, { uid: after.customerId || "", emailId: `on-way-${deliveryId}` });
      }
    }

    /* Status → nearby */
    if (before.status !== after.status && after.status === "nearby") {
      const email = after.customerEmail || await emailForUid(after.customerId || "");
      if (email) {
        await trigger("driver-nearby", {
          name:        after.customerName || "Customer",
          deliveryId,
          driverName:  after.driverName || "Your driver",
          distance:    after.nearbyDistance || "a few minutes",
          email,
        }, { uid: after.customerId || "", emailId: `nearby-${deliveryId}` });
      }
    }

    /* Status → failed */
    if (before.status !== after.status && after.status === "failed") {
      const email = after.customerEmail || await emailForUid(after.customerId || "");
      if (email) {
        await trigger("delivery-failed", {
          name:        after.customerName || "Customer",
          orderId:     after.orderId || deliveryId,
          deliveryId,
          reason:      after.failureReason || "Customer not available",
          attemptedAt: after.updatedAt?.toDate?.()?.toLocaleString("en-KE") || "",
          email,
        }, { uid: after.customerId || "", emailId: `delivery-failed-${deliveryId}` });
      }
    }

    /* ETA updated */
    if (before.eta !== after.eta && after.eta && before.eta) {
      const email = after.customerEmail || await emailForUid(after.customerId || "");
      if (email) {
        await trigger("eta-update", {
          name:       after.customerName || "Customer",
          orderId:    after.orderId || deliveryId,
          deliveryId,
          eta:        after.eta,
          reason:     after.etaUpdateReason || "",
          email,
        }, { uid: after.customerId || "", emailId: `eta-update-${deliveryId}-${Date.now()}` });
      }
    }
  }
);

/* ═══════════════════════════════════════════════════════════
   DRIVERS: Registration + approval + rejection + doc expiry
═══════════════════════════════════════════════════════════ */
exports.emailOnDriverCreate = onDocumentCreated(
  { document: "drivers/{driverId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const d = event.data?.data() || {};
    const email = d.email || await emailForUid(d.uid || "");
    if (!email) return;
    await trigger("driver-welcome", {
      name:  d.displayName || d.name || "Driver",
      email,
    }, { uid: d.uid || "", emailId: `driver-welcome-${event.params.driverId}` });
  }
);

exports.emailOnDriverStatusChange = onDocumentUpdated(
  { document: "drivers/{driverId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    const driverId = event.params.driverId;
    if (before.status === after.status) return;
    const email = after.email || await emailForUid(after.uid || "");
    if (!email) return;
    const d = {
      name:     after.displayName || after.name || "Driver",
      driverId,
      vehicle:  after.vehicleType || after.vehicle || "",
      zone:     after.zone || "All Nairobi",
      reason:   after.rejectionReason || "",
      email,
    };
    if (after.status === "approved") await trigger("driver-approved", d, { uid: after.uid || "", emailId: `driver-approved-${driverId}` });
    else if (after.status === "rejected") await trigger("driver-rejected", d, { uid: after.uid || "", emailId: `driver-rejected-${driverId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   EVENTS & TICKETS: Ticket purchase confirmation
═══════════════════════════════════════════════════════════ */
exports.emailOnTicketCreate = onDocumentCreated(
  { document: "tickets/{ticketId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const t = event.data?.data() || {};
    const email = t.customerEmail || await emailForUid(t.customerId || "");
    if (!email) return;
    await trigger("ticket-purchase", {
      name:       t.customerName || "Guest",
      eventName:  t.eventName || "",
      eventDate:  t.eventDate || "",
      venue:      t.venue || "",
      ticketType: t.ticketType || "General",
      ticketId:   event.params.ticketId,
      amount:     t.price || 0,
      qrCode:     t.qrCodeUrl || "",
      email,
    }, { uid: t.customerId || "", emailId: `ticket-${event.params.ticketId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   PROPERTY: Enquiry + booking
═══════════════════════════════════════════════════════════ */
exports.emailOnPropertyEnquiry = onDocumentCreated(
  { document: "propertyEnquiries/{enquiryId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const e = event.data?.data() || {};
    const ownerEmail = e.ownerEmail || await emailForUid(e.ownerId || "");
    if (!ownerEmail) return;
    await trigger("property-enquiry", {
      name:          e.ownerName || "Owner",
      propertyTitle: e.propertyTitle || "Your Property",
      enquirerName:  e.enquirerName || "A user",
      enquirerPhone: e.enquirerPhone || "",
      message:       e.message || "",
      email:         ownerEmail,
    }, { uid: e.ownerId || "", emailId: `enquiry-${event.params.enquiryId}` });
  }
);

exports.emailOnBookingCreate = onDocumentCreated(
  { document: "bookings/{bookingId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const b = event.data?.data() || {};
    const email = b.customerEmail || await emailForUid(b.customerId || "");
    if (!email) return;
    await trigger("booking-confirmation", {
      name:         b.customerName || "Customer",
      bookingTitle: b.title || b.propertyTitle || "Your Booking",
      checkIn:      b.checkIn || "",
      checkOut:     b.checkOut || "",
      ref:          event.params.bookingId,
      total:        b.total || 0,
      email,
    }, { uid: b.customerId || "", emailId: `booking-${event.params.bookingId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   HEALTHCARE: Appointment confirmation
═══════════════════════════════════════════════════════════ */
exports.emailOnAppointmentCreate = onDocumentCreated(
  { document: "appointments/{apptId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const a = event.data?.data() || {};
    const email = a.patientEmail || await emailForUid(a.patientId || "");
    if (!email) return;
    await trigger("appointment-confirmation", {
      name:         a.patientName || "Patient",
      providerName: a.providerName || "Your Provider",
      date:         a.date || "",
      time:         a.time || "",
      location:     a.location || "",
      type:         a.type || "",
      email,
    }, { uid: a.patientId || "", emailId: `appt-${event.params.apptId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   LEGAL: Consultation confirmation
═══════════════════════════════════════════════════════════ */
exports.emailOnLegalConsultation = onDocumentCreated(
  { document: "legalConsultations/{consultId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const c = event.data?.data() || {};
    const email = c.clientEmail || await emailForUid(c.clientId || "");
    if (!email) return;
    await trigger("legal-consultation", {
      name:        c.clientName || "Client",
      lawyerName:  c.lawyerName || "Your Lawyer",
      specialty:   c.specialty || "",
      date:        c.date || "",
      time:        c.time || "",
      fee:         c.fee || 0,
      email,
    }, { uid: c.clientId || "", emailId: `legal-${event.params.consultId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   REVIEWS: Post-delivery review request (24h after delivery)
   Queues a review request instead of sending immediately.
═══════════════════════════════════════════════════════════ */
exports.emailOnOrderDelivered = onDocumentUpdated(
  { document: "orders/{orderId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status || after.status !== "delivered") return;
    const orderId = event.params.orderId;
    const email = after.customerEmail || await emailForUid(after.customerId || "");
    if (!email) return;

    /* Queue the delivered email first */
    await trigger("order-delivered", {
      name:        after.customerName || "Customer",
      orderId,
      deliveredAt: after.deliveredAt?.toDate?.()?.toLocaleString("en-KE") || "Just now",
      driverName:  after.driverName || "",
      email,
    }, { uid: after.customerId || "", emailId: `order-delivered-${orderId}` });

    /* Queue review request — schedule 24 hours later via emailQueue */
    const sendAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const reviewTmpl = getTemplate("review-request", {
      name:        after.customerName || "Customer",
      productName: after.items?.[0]?.name || "your purchase",
      orderId,
    });
    await emailSvc.queue({
      to:         email,
      subject:    reviewTmpl.subject,
      html:       reviewTmpl.html,
      from:       reviewTmpl.from,
      category:   reviewTmpl.category,
      template:   "review-request",
      uid:        after.customerId || "",
      emailId:    `review-${orderId}`,
      nextAttempt: admin.firestore.Timestamp.fromDate(sendAt),
    });
  }
);

/* ═══════════════════════════════════════════════════════════
   ORDERS: Confirmation email on new order creation
═══════════════════════════════════════════════════════════ */
exports.emailOnOrderCreated = onDocumentCreated(
  { document: "orders/{orderId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const d       = event.data.data();
    const orderId = event.params.orderId;
    const email   = d.customerEmail || await emailForUid(d.customerId || "");
    if (!email) return;

    const items = (d.items || [])
      .map(i => i.name || i.title || "Item").filter(Boolean).join(", ")
      || "See order details";

    await trigger("order-confirmation", {
      name:              d.customerName  || "Customer",
      orderId,
      items,
      total:             d.orderTotal    || d.total || 0,
      paymentMethod:     d.paymentMethod || "M-Pesa",
      deliveryAddress:   d.deliveryAddress || "",
      estimatedDelivery: d.estimatedDelivery || "",
      email,
    }, { uid: d.customerId || "", emailId: `order-confirm-${orderId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   ORDERS: Shipped notification on status → "shipped"
═══════════════════════════════════════════════════════════ */
exports.emailOnOrderShipped = onDocumentUpdated(
  { document: "orders/{orderId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status || after.status !== "shipped") return;
    const orderId = event.params.orderId;
    const email   = after.customerEmail || await emailForUid(after.customerId || "");
    if (!email) return;

    await trigger("order-shipped", {
      name:         after.customerName  || "Customer",
      orderId,
      driverName:   after.driverName    || "",
      eta:          after.estimatedArrival || after.eta || "",
      trackingCode: after.trackingCode  || "",
      email,
    }, { uid: after.customerId || "", emailId: `order-shipped-${orderId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   ORDERS: Cancellation email on status → "cancelled"
═══════════════════════════════════════════════════════════ */
exports.emailOnOrderCancelled = onDocumentUpdated(
  { document: "orders/{orderId}", secrets: EMAIL_SECRETS },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (before.status === after.status || after.status !== "cancelled") return;
    const orderId = event.params.orderId;
    const email   = after.customerEmail || await emailForUid(after.customerId || "");
    if (!email) return;

    await trigger("order-cancelled", {
      name:    after.customerName || "Customer",
      orderId,
      reason:  after.cancellationReason || after.reason || "",
      email,
    }, { uid: after.customerId || "", emailId: `order-cancelled-${orderId}` });
  }
);

/* ═══════════════════════════════════════════════════════════
   SCHEDULED: Process email queue every 5 minutes
═══════════════════════════════════════════════════════════ */
exports.processEmailQueue = onSchedule(
  { schedule: "every 5 minutes", secrets: EMAIL_SECRETS },
  async () => {
    const sent = await emailSvc.processQueue();
    console.log(`[EmailQueue] Processed ${sent} emails`);
  }
);

/* ═══════════════════════════════════════════════════════════
   SCHEDULED: Subscription expiry reminders (daily 08:00 EAT)
═══════════════════════════════════════════════════════════ */
exports.emailSubscriptionReminders = onSchedule(
  { schedule: "every day 05:00", secrets: EMAIL_SECRETS },
  async () => {
    const db = admin.firestore();
    const now = new Date();
    /* Remind at 7 days and 1 day before expiry */
    for (const days of [7, 1]) {
      const targetDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const start = new Date(targetDate); start.setHours(0, 0, 0, 0);
      const end   = new Date(targetDate); end.setHours(23, 59, 59, 999);
      const snap = await db.collection("subscriptions")
        .where("status", "==", "active")
        .where("expiresAt", ">=", admin.firestore.Timestamp.fromDate(start))
        .where("expiresAt", "<=", admin.firestore.Timestamp.fromDate(end))
        .limit(200).get().catch(() => null);
      if (!snap || snap.empty) continue;
      for (const doc of snap.docs) {
        const s = doc.data();
        const email = s.email || await emailForUid(s.uid || "");
        if (!email) continue;
        await trigger("subscription-expiring", {
          name:       s.displayName || "User",
          plan:       s.plan || "SOKONI Plan",
          days:       String(days),
          expiryDate: s.expiresAt?.toDate?.()?.toLocaleDateString("en-KE") || "",
          email,
        }, { uid: s.uid || "", emailId: `sub-expiring-${doc.id}-${days}d` });
      }
    }
  }
);

/* ═══════════════════════════════════════════════════════════
   SCHEDULED: Driver document expiry reminders (daily 06:00 EAT)
═══════════════════════════════════════════════════════════ */
exports.emailDriverDocReminders = onSchedule(
  { schedule: "every day 03:00", secrets: EMAIL_SECRETS },
  async () => {
    const db = admin.firestore();
    const now = new Date();
    const DOC_FIELDS = ["licenceExpiry", "insuranceExpiry", "ntsa3Expiry", "goodConductExpiry"];
    const DOC_NAMES  = {
      licenceExpiry:     "Driving Licence",
      insuranceExpiry:   "Vehicle Insurance",
      ntsa3Expiry:       "NTSA Certificate",
      goodConductExpiry: "Certificate of Good Conduct",
    };
    for (const days of [30, 14, 7]) {
      const targetDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const targetStr  = targetDate.toISOString().slice(0, 10);
      const snap = await db.collection("drivers")
        .where("status", "==", "approved").limit(200).get().catch(() => null);
      if (!snap || snap.empty) continue;
      for (const doc of snap.docs) {
        const d = doc.data();
        const email = d.email || await emailForUid(d.uid || "");
        if (!email) continue;
        for (const field of DOC_FIELDS) {
          if (!d[field]) continue;
          const expiry = d[field].toDate ? d[field].toDate() : new Date(d[field]);
          const expiryStr = expiry.toISOString().slice(0, 10);
          if (expiryStr === targetStr) {
            await trigger("driver-doc-expiry", {
              name:       d.displayName || d.name || "Driver",
              docName:    DOC_NAMES[field] || field,
              expiryDate: expiry.toLocaleDateString("en-KE"),
              days:       String(days),
              email,
            }, { uid: d.uid || "", emailId: `doc-expiry-${doc.id}-${field}-${days}d` });
          }
        }
      }
    }
  }
);

/* ═══════════════════════════════════════════════════════════
   SCHEDULED: Unassigned delivery alert (every 30 minutes)
═══════════════════════════════════════════════════════════ */
exports.emailUnassignedDeliveryAlert = onSchedule(
  { schedule: "every 30 minutes", secrets: EMAIL_SECRETS },
  async () => {
    const db = admin.firestore();
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const snap = await db.collection("deliveries")
      .where("status", "==", "pending")
      .where("driverId", "==", null)
      .where("createdAt", "<=", admin.firestore.Timestamp.fromDate(thirtyMinAgo))
      .limit(20).get().catch(() => null);
    if (!snap || snap.empty) return;
    /* Get all admin emails */
    const adminSnap = await db.collection("users")
      .where("role", "in", ["admin", "superAdmin"]).limit(10).get().catch(() => null);
    const adminEmails = (adminSnap?.docs || []).map(d => d.data().email).filter(Boolean);
    for (const doc of snap.docs) {
      const d = doc.data();
      for (const adminEmail of adminEmails) {
        await trigger("dispatch-unassigned-alert", {
          orderId:      d.orderId || doc.id,
          customerName: d.customerName || "Customer",
          pickup:       d.pickupAddress || "N/A",
          dropoff:      d.dropoffAddress || "N/A",
          waitingSince: d.createdAt?.toDate?.()?.toLocaleTimeString("en-KE") || "",
          waitTime:     "30 minutes",
          email:        adminEmail,
        }, { emailId: `unassigned-alert-${doc.id}-${Date.now()}` });
      }
    }
  }
);

/* ═══════════════════════════════════════════════════════════
   SendGrid Event Webhook  (track opens, clicks, bounces)
   Register: https://us-central1-sokoni-aeb26.cloudfunctions.net/emailWebhook
═══════════════════════════════════════════════════════════ */
exports.emailWebhook = onRequest({ invoker: "public", secrets: [SENDGRID_WEBHOOK_KEY] }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).end(); return; }

  /* Verify SendGrid HMAC-SHA256 webhook signature when key is configured.
     If the env var is absent we accept (dev/CI mode) but log a warning. */
  const webhookKey = SENDGRID_WEBHOOK_KEY.value() || "";
  const sgSig  = req.headers["x-twilio-email-event-webhook-signature"] || "";
  const sgTs   = req.headers["x-twilio-email-event-webhook-timestamp"] || "";

  if (webhookKey) {
    const crypto = require("crypto");
    const rawBody = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body);
    const payload = sgTs + rawBody;
    const expected = crypto.createHmac("sha256", webhookKey).update(payload).digest("base64");
    if (sgSig && expected !== sgSig) {
      console.warn("[emailWebhook] Invalid signature — request rejected");
      res.status(403).json({ error: "invalid_signature" });
      return;
    }
  } else {
    console.warn("[emailWebhook] SENDGRID_WEBHOOK_KEY not set — signature not verified");
  }

  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const event of events) {
    const msgId = event.sg_message_id || event["smtp-id"] || "";
    switch (event.event) {
      case "open":    await emailSvc.markOpened(msgId);                          break;
      case "click":   await emailSvc.markClicked(msgId);                         break;
      case "bounce":
      case "dropped": await emailSvc.markBounced(event.email || "", msgId);      break;
    }
  }
  res.status(200).json({ received: events.length });
});

/* ═══════════════════════════════════════════════════════════
   onCall: Update user email preferences
═══════════════════════════════════════════════════════════ */
exports.updateEmailPreferences = onCall(
  { secrets: EMAIL_SECRETS },
  async (req) => {
    const uid = assertAuth(req);
    const { prefs } = req.data || {};
    if (!prefs || typeof prefs !== "object") throw new HttpsError("invalid-argument", "prefs required");
    await emailSvc.updatePreferences(uid, prefs);
    return { success: true };
  }
);

/* ═══════════════════════════════════════════════════════════
   onCall: Admin broadcast email
═══════════════════════════════════════════════════════════ */
exports.sendBroadcastEmail = onCall(
  { secrets: EMAIL_SECRETS },
  async (req) => {
    const uid = assertAuth(req);
    /* Verify admin */
    const user = await admin.auth().getUser(uid);
    const claims = user.customClaims || {};
    if (!claims.isAdmin && !claims.isSuperAdmin) throw new HttpsError("permission-denied", "Admin required");
    const { subject, html, to, category } = req.data || {};
    if (!subject || !html || !to) throw new HttpsError("invalid-argument", "subject, html, to required");
    const targets = Array.isArray(to) ? to : [to];
    let sent = 0;
    for (const address of targets) {
      await emailSvc.queue({ to: address, subject, html, category: category || "system", emailId: `broadcast-${Date.now()}-${sent}` });
      sent++;
    }
    return { queued: sent };
  }
);

/* ═══════════════════════════════════════════════════════════
   onCall: Resend any email (admin)
═══════════════════════════════════════════════════════════ */
exports.resendEmail = onCall(
  { secrets: EMAIL_SECRETS },
  async (req) => {
    const uid = assertAuth(req);
    const user = await admin.auth().getUser(uid);
    if (!user.customClaims?.isAdmin && !user.customClaims?.isSuperAdmin) throw new HttpsError("permission-denied", "Admin required");
    const { logId } = req.data || {};
    if (!logId) throw new HttpsError("invalid-argument", "logId required");
    const snap = await admin.firestore().collection("emailLogs").doc(logId).get();
    if (!snap.exists) throw new HttpsError("not-found", "Email log not found");
    const log = snap.data();
    await emailSvc.send({ ...log, emailId: `resend-${logId}-${Date.now()}` });
    return { success: true };
  }
);

/* ═══════════════════════════════════════════════════════════
   onCall: Record login event — detect new devices and send
   login-alert email. Called from frontend after every sign-in.
   Throttled: max 1 alert per device per 24 h.
═══════════════════════════════════════════════════════════ */
exports.onLoginEvent = onCall(
  { secrets: EMAIL_SECRETS, maxInstances: 20 },
  async (req) => {
    const uid = assertAuth(req);
    const { device, ip, location, userAgent, fingerprint } = req.data || {};

    const deviceKey = (fingerprint || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "unknown";
    const db        = admin.firestore();
    const deviceRef = db.collection("users").doc(uid)
                        .collection("knownDevices").doc(deviceKey);

    const snap    = await deviceRef.get();
    const isNew   = !snap.exists;
    const now     = admin.firestore.FieldValue.serverTimestamp();
    const nowMs   = Date.now();

    /* Throttle: skip alert if same device seen in last 24 h */
    const lastSeen  = snap.exists ? (snap.data().lastSeenMs || 0) : 0;
    const throttled = !isNew && (nowMs - lastSeen) < 86_400_000;

    /* Always upsert the device record */
    await deviceRef.set({
      device:      device    || userAgent || "Unknown",
      ip:          ip        || "",
      location:    location  || "Kenya",
      userAgent:   userAgent || "",
      firstSeenMs: isNew ? nowMs : (snap.data().firstSeenMs || nowMs),
      lastSeenMs:  nowMs,
      lastSeen:    now,
    }, { merge: true });

    if (throttled) return { sent: false, reason: "throttled" };

    /* Fetch user details */
    const authUser = await admin.auth().getUser(uid);
    const email    = authUser.email || "";
    if (!email) return { sent: false, reason: "no_email" };

    const userDoc = await db.collection("users").doc(uid).get();
    const name    = userDoc.exists
      ? (userDoc.data().displayName || userDoc.data().name || authUser.displayName || "there")
      : (authUser.displayName || "there");

    const sentAt = new Date().toLocaleString("en-KE", {
      timeZone: "Africa/Nairobi", dateStyle: "medium", timeStyle: "short",
    });

    await trigger("login-alert", {
      name,
      email,
      device:   device   || userAgent || "Unknown device",
      ip:       ip       || "Unknown",
      location: location || "Kenya",
      time:     sentAt,
    }, {
      uid,
      emailId: `login-alert-${uid}-${deviceKey}-${nowMs}`,
    });

    return { sent: true, isNewDevice: isNew };
  }
);
