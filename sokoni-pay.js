/**
 * SOKONI Payment Gateway — Universal Commission & Booking Deposit System
 * Every booking, WhatsApp connect, and service interaction passes through here.
 * SOKONI earns its cut whether payment happens on-platform or off.
 */
(function(global){
'use strict';

/* Commission percentages come from SokoniCommission (sokoni-commission-rates.js, generated
   from functions/commission-config.js). If that file did not load, we must NOT fall back to
   an invented rate — showing a seller the wrong percentage is exactly the bug being removed.
   Fail loudly instead: the platform default is used and the mistake is reported, rather than
   silently charging a number nobody chose. */
if (typeof window !== 'undefined' && !window.SokoniCommission) {
  console.error('[SokoniPay] sokoni-commission-rates.js did not load — commission rates are '
    + 'unavailable. Load it BEFORE sokoni-pay.js.');
  window.SokoniCommission = {
    pct: function () { return 5; },          /* the platform default, per commission-config */
    fixedKES: function () { return 0; },
    _degraded: true,
  };
}

const _esc = s => String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ═══════════════════════════════════════════════════════════
   COMMISSION RATES — what SOKONI earns per category
═══════════════════════════════════════════════════════════ */
/* Commission PERCENTAGES are no longer defined here. They live in
     functions/commission-config.js and reach the browser via sokoni-commission-rates.js
     (generated). What remains below is only the flat service pricing — deposits, lead fees,
     phone-reveal fees — which are fees, not commission rates.

     The percentages that used to sit here had already drifted from the server: this file said
     legal 5% while the finos engine said 12%, and it advertised 12% for car-rental and 10% for
     plumbing, neither of which the server ever charged. Use SokoniCommission.pct(category);
     it always returns a number, so never write a `|| 10` fallback. */
/* Flat service fees — booking deposits, phone-reveal fees, lead fees. These are PRICES, not
   commission rates, and they are deliberately not in commission-config.js.
   Commission percentages come from SokoniCommission.pct(). */
const SERVICE_FEES = {
  // Booking deposit (paid upfront, guaranteed)
  deposits: {
    default:          200,   // Standard service
    legal:            500,   // Legal consultation
    healthcare:       200,   // Medical appointment
    entertainment:    500,   // DJ / performer
    'car-rental':     1500,  // Car rental (10% of ~KES 15,000 avg)
    construction:     300,   // Quote / material order
    sports:           150,   // Facility / coaching
    'hair-beauty':    200,
    plumbing:         200,
    electrical:       200,
    cleaning:         150,
    photography:      300,
    fitness:          150,
    catering:         300,
    property:         500,   // Property viewing connection (tenant pays)
    bnb:              500,   // BnB hold deposit (part of platformBook flow)
    ride:             100,   // Ride booking hold
  },
  // Platform commission % on total service fee (invoiced after completion)

  // Phone/contact reveal fee (Channel: Call Lead)
  phoneLead: {
    default:          100,
    property:         150,
    legal:            150,
    healthcare:        50,
    'hair-beauty':     50,
    fitness:           50,
    tutoring:          50,
    b2b:              200,
    banking:          100,
  },

  // Provider-side lead/RFQ connection fee (Channel: Lead Match)
  leadFee: {
    default:          300,
    b2b:              500,
    banking:          200,
    property:         500,
    insurance:        300,
  },

  // % of total booking value — platform-native bookings (Channel: Platform Book)
};

/* ═══════════════════════════════════════════════════════════
   SUBSCRIPTION PLANS
═══════════════════════════════════════════════════════════ */
/* PLANS carries no commissionPct any more. It advertised absolute rates (free 15%, business 4%)
   that the server never enforced and that no longer match any real base rate — marketplace is 3%.
   A seller's plan benefit is now applied server-side inside the one Commission Engine and returned
   by previewCommission as { baseRate, planAdjustment, effectiveRate, reason }. Display that. */
const PLANS = {
  free:     { name:"Free",     price:0,    listings:3,   badge:false, featured:false, leads:5,   label:"Get started free" },
  starter:  { name:"Starter",  price:499,  listings:20,  badge:true,  featured:false, leads:30,  label:"Best for new sellers" },
  pro:      { name:"Pro",      price:1499, listings:999, badge:true,  featured:true,  leads:999, label:"Most popular" },
  business: { name:"Business", price:4999, listings:999, badge:true,  featured:true,  leads:999, label:"For agencies & large sellers" },
};

/* ═══════════════════════════════════════════════════════════
   STORAGE HELPERS
═══════════════════════════════════════════════════════════ */
function getRecords(key){ try{ return JSON.parse(localStorage.getItem(key)||"[]"); }catch(e){ return []; } }
function saveRecords(key,data){ localStorage.setItem(key, JSON.stringify(data)); }
function getConfig(key,def){ return localStorage.getItem(key)||def; }

function saveBookingFee(record){
  const r=getRecords("sokoniBookingFees"); r.unshift(record); saveRecords("sokoniBookingFees",r);
  /* Use the v8 compat Firestore instance (window.firebaseDB) with the v8 API.
     Previously this imported the v9 modular SDK and passed the v8 compat instance
     to v9 doc() — causing silent write failures. Fixed to stay in v8 compat. */
  (function(){
    var db=window.firebaseDB; if(!db) return;
    var auth=window.firebaseAuth; var uid=(auth&&auth.currentUser&&auth.currentUser.uid)||null;
    if(!uid) return; /* Must be authenticated to write bookingFees */
    var id=record.ref||('BF'+Date.now());
    /* Firestore rule requires uid, amount, type fields */
    var serverTs=window.firebase?.firestore?.FieldValue?.serverTimestamp?.();
    var fsRecord=Object.assign({},record,{
      uid:uid,
      amount:record.totalPaid||record.depositAmount||record.amount||0,
      type:'booking_fee',
      savedAt:serverTs||Date.now()
    });
    db.collection('bookingFees').doc(id).set(fsRecord).catch(function(){});
  })();
}
function saveCommissionRecord(record){
  /* localStorage ledger only — Firestore commissionLedger is written exclusively by
     the intasendWebhook Cloud Function after server-confirmed payment. Client writes
     to commissionLedger are blocked by Firestore rules (admin-only). */
  const r=getRecords("sokoniCommissionLedger"); r.unshift(record); saveRecords("sokoniCommissionLedger",r);
}
/* legacy alias kept for old code */
function saveCommissionObligation(record){ saveCommissionRecord(record); }
function totalRevenue(){ return getRecords("sokoniBookingFees").reduce((s,r)=>s+(r.totalPaid||r.depositAmount||r.amount||0),0); }
function totalCommissionCollected(){ return getRecords("sokoniCommissionLedger").filter(r=>r.status==="auto_collected"||r.status==="collected").reduce((s,r)=>s+(r.sokoniCut||0),0); }
/* legacy */
function totalCommissionOwed(){ return getRecords("sokoniCommissionLedger").filter(r=>r.status==="pending").reduce((s,r)=>s+(r.commissionOwed||0),0); }

/* ═══════════════════════════════════════════════════════════
   BOOKING REFERENCE GENERATOR
═══════════════════════════════════════════════════════════ */
function genRef(prefix){ return (prefix||"SKN")+Date.now().toString(36).toUpperCase().slice(-6); }

/* ═══════════════════════════════════════════════════════════
   GATEWAY MODAL — shown before any booking / WA connect
═══════════════════════════════════════════════════════════ */
function showGateway(options){
  return new Promise((resolve)=>{
    /*
      options = {
        providerName, category, serviceDesc, depositAmount,
        providerPhone, onSuccess(ref), onCancel
      }
    */
    /* Was written as a two-line fallback with the `||` missing:
           SokoniCommission.pct(options.category)
           SokoniCommission.pct("default");
       ASI split that into an assignment plus a discarded no-op call, so the
       "fallback" never ran. Harmless only by luck — resolve() in
       sokoni-commission-rates.js:132-139 already returns RATES.default for any
       unrecognised key, so pct() cannot return undefined. The fallback was
       redundant as well as dead; one call is the correct expression. */
    const commissionPct = SokoniCommission.pct(options.category);

    /* If caller provides the full service total, collect it all through SOKONI.
       Otherwise fall back to the small upfront deposit (legacy behaviour). */
    const serviceTotal   = Number(options.serviceTotal||0);
    const depositFallback = options.depositAmount ||
      SERVICE_FEES.deposits[options.category] ||
      SERVICE_FEES.deposits.default;
    const payAmount      = serviceTotal > 0 ? serviceTotal : depositFallback;
    const sokoniCut      = Math.round(payAmount * commissionPct / 100);
    const providerNet    = payAmount - sokoniCut;
    const fullPayment    = serviceTotal > 0;   /* true = full amount through SOKONI */
    /* Alias for backward-compat (older code may still reference depositAmount) */
    const depositAmount  = payAmount;

    /* Build modal */
    /* Honour a server-minted reference when the caller supplies one.

       createPaymentIntent writes paymentIntents/{ref} and initiateSTKPush
       enforces the amount against that document. Minting a fresh ref here
       would orphan the intent — the push would arrive under a reference the
       server has no authority record for, and an enforced caller would have
       its payment refused. Callers that do not mint an intent keep the
       generated ref exactly as before. */
    const ref = (options && options.paymentIntentId) || (options && options.ref) || genRef("SKN");
    const modal = document.createElement("div");
    modal.id = "sokoniPayGateway";
    modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.88);backdrop-filter:blur(16px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;";
    modal.innerHTML = `
      <div style="background:#111;border:1px solid rgba(113,255,0,0.2);border-radius:24px;padding:28px;max-width:420px;width:100%;position:relative;animation:spGateIn .3s cubic-bezier(.34,1.56,.64,1);">
        <style>@keyframes spGateIn{from{transform:scale(.85) translateY(20px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}</style>
        <button id="spClose" style="position:absolute;top:14px;right:16px;background:none;border:none;color:rgba(255,255,255,0.3);font-size:20px;cursor:pointer;">✕</button>

        <!-- SOKONI branding -->
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">
          <img src="assets/sokoni-logo-dark.png" style="height:28px;" onerror="this.style.display='none'">
          <div style="font-size:11px;font-weight:800;color:rgba(113,255,0,0.7);text-transform:uppercase;letter-spacing:.08em;">Secure Booking</div>
        </div>

        <!-- Provider info -->
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:14px 16px;margin-bottom:16px;">
          <div style="font-size:13px;font-weight:800;color:white;margin-bottom:4px;">${_esc(options.providerName||"Service Provider")}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.45);">${_esc(options.serviceDesc||"Professional Service")}</div>
        </div>

        <!-- Payment Breakdown -->
        <div style="background:rgba(113,255,0,0.05);border:1px solid rgba(113,255,0,0.14);border-radius:14px;padding:16px;margin-bottom:16px;">
          <div style="font-size:11px;font-weight:800;color:rgba(113,255,0,0.7);text-transform:uppercase;letter-spacing:.07em;margin-bottom:12px;">💳 Payment Breakdown</div>
          <div style="display:flex;justify-content:space-between;font-size:13px;color:white;font-weight:800;margin-bottom:8px;">
            <span>${fullPayment ? '💸 Total You Pay' : '🔒 Booking Deposit'}</span>
            <span style="color:#71ff00;">KES ${payAmount.toLocaleString()}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:6px;">
            <span>⚙️ SOKONI Platform Fee (${commissionPct}%)</span>
            <span>KES ${sokoniCut.toLocaleString()}</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:rgba(0,200,120,0.9);font-weight:800;padding-top:8px;border-top:1px solid rgba(255,255,255,0.07);">
            <span>💚 ${fullPayment ? 'Provider Receives' : 'After Completion'}</span>
            <span>KES ${providerNet.toLocaleString()}</span>
          </div>
          ${fullPayment
            ? `<div style="font-size:10px;color:rgba(113,255,0,0.5);margin-top:8px;line-height:1.6;">✅ Commission auto-deducted — payment goes through SOKONI account, provider receives their net amount automatically.</div>`
            : `<div style="font-size:10px;color:rgba(255,255,255,0.25);margin-top:8px;line-height:1.6;">Deposit secures your slot. Full service fee collected at completion — commission auto-deducted at that point.</div>`
          }
        </div>

        <!-- Phone input -->
        <div style="margin-bottom:14px;">
          <label style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.4);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em;">Your M-PESA Number *</label>
          <input id="spPhone" type="tel" placeholder="07XXXXXXXX" value="${_getLoggedInPhone()}" style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:11px;color:white;font-size:14px;outline:none;font-family:inherit;">
        </div>

        <!-- Pay button -->
        <button id="spPayBtn" style="width:100%;padding:14px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-weight:900;font-size:14px;border:none;border-radius:12px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;">
          📲 Pay KES ${payAmount.toLocaleString()} via M-PESA
        </button>

        <div id="spMsg" style="font-size:12px;margin-top:10px;text-align:center;min-height:14px;color:rgba(255,255,255,0.5);"></div>

        <!-- Booking reference (shown after payment) -->
        <div id="spRefBox" style="display:none;background:rgba(0,170,255,0.08);border:1px solid rgba(0,170,255,0.2);border-radius:10px;padding:10px 14px;margin-top:12px;text-align:center;">
          <div style="font-size:10px;color:rgba(255,255,255,0.35);">Booking Reference</div>
          <div style="font-size:20px;font-weight:900;color:#00aaff;letter-spacing:.1em;">${ref}</div>
          <div style="font-size:10px;color:rgba(255,255,255,0.3);margin-top:3px;">Quote this ref to your provider</div>
        </div>

        <!-- Continue button (after payment) -->
        <button id="spContinueBtn" style="display:none;width:100%;padding:13px;background:linear-gradient(135deg,#00aaff,#0077cc);color:white;font-weight:900;font-size:14px;border:none;border-radius:12px;cursor:pointer;font-family:inherit;margin-top:10px;">
          ✅ Continue to Provider →
        </button>

        <div style="text-align:center;margin-top:12px;font-size:10px;color:rgba(255,255,255,0.2);">
          🔒 Secured by SOKONI · Powered by M-PESA
        </div>
      </div>`;

    document.body.appendChild(modal);

    /* Close button */
    modal.querySelector("#spClose").addEventListener("click",()=>{
      modal.remove();
      if(options.onCancel) options.onCancel();
      resolve(null);
    });
    modal.addEventListener("click", e=>{ if(e.target===modal){ modal.remove(); resolve(null); } });

    /* Pay button */
    const payBtn = modal.querySelector("#spPayBtn");
    const msgEl  = modal.querySelector("#spMsg");
    const refBox = modal.querySelector("#spRefBox");
    const contBtn= modal.querySelector("#spContinueBtn");

    payBtn.addEventListener("click", async ()=>{
      const phone = modal.querySelector("#spPhone").value.trim();
      if(!phone||!/^0[17]\d{8}$/.test(phone.replace(/\s/g,""))){
        msgEl.textContent="⚠️ Enter a valid M-PESA number (07XX or 01XX)";
        msgEl.style.color="#ff9800"; return;
      }

      /* Use SokoniIntaSend for real payment if available */
      const IS = window.SokoniIntaSend;
      if(!IS){
        msgEl.textContent="⚠️ Payment system loading… please refresh and try again.";
        msgEl.style.color="#ff9800"; return;
      }

      payBtn.disabled=true;
      payBtn.textContent="⏳ Sending M-PESA request…";
      msgEl.textContent="";
      msgEl.style.color="#fbbf24";

      try {
        /* Step 1: initiate STK Push via Cloud Function */
        await IS.initiateSTKPush(phone, payAmount, ref, {
          providerName:  options.providerName||"",
          serviceDesc:   options.serviceDesc||"",
          category:      options.category||"default",
          commissionPct,
          /* Booking linkage — the webhook uses these to create bookings/{ref} and
             notify both parties on payment COMPLETE. */
          type:          options.bookingType || undefined,
          providerId:    options.providerId  || undefined,
          providerPhone: options.providerPhone || undefined,
        });

        msgEl.textContent="📲 M-PESA prompt sent to "+phone+" — enter your PIN on your phone";
        msgEl.style.color="#fbbf24";
        payBtn.textContent="⏳ Waiting for payment confirmation…";

        /* Step 2: wait for webhook confirmation via Firestore realtime listener */
        const receipt = await IS.waitForConfirmation(ref, {
          providerName:  options.providerName||"",
          serviceDesc:   options.serviceDesc||"",
          category:      options.category||"default",
          amount:        payAmount,
          sokoniCut,
          providerNet,
          commissionPct,
          phone,
          providerPhone: options.providerPhone||"",
          fullPayment,
        }, (status)=>{
          if(status==="PENDING") msgEl.textContent="⏳ Waiting for M-PESA confirmation…";
          else if(status==="FAILED") msgEl.textContent="❌ Payment failed. Please retry.";
        });

        /* Payment confirmed server-side — safe to unlock */
        payBtn.style.display="none";
        refBox.style.display="block";
        contBtn.style.display="block";
        msgEl.textContent="✅ Payment confirmed! Ref: "+ref;
        msgEl.style.color="#71ff00";

        contBtn.addEventListener("click",()=>{
          modal.remove();
          if(options.onSuccess) options.onSuccess(ref);
          resolve(ref);
        });

      } catch(err){
        payBtn.disabled=false;
        payBtn.innerHTML="📲 Pay KES "+payAmount.toLocaleString()+" via M-PESA";
        msgEl.textContent="❌ "+(err.message||"Payment failed. Please try again.");
        msgEl.style.color="#ff5555";
      }
    });
  });
}

/* ═══════════════════════════════════════════════════════════
   WHATSAPP CONNECT — intercept every WA link with deposit
═══════════════════════════════════════════════════════════ */
function waConnect(providerPhone, message, opts){
  /*
    opts = { providerName, category, serviceDesc }
    Opens booking gateway first, then WhatsApp with ref embedded
  */
  opts = opts || {};
  showGateway({
    providerName:  opts.providerName  || "Service Provider",
    category:      opts.category      || "default",
    serviceDesc:   opts.serviceDesc   || "Book via WhatsApp",
    providerPhone: providerPhone,
    onSuccess: function(ref){
      const fullMsg = "📋 Booking Ref: *"+ref+"*\n\n"+message+"\n\n_Booked via SOKONI_";
      const ph = providerPhone.replace(/^0/,"254").replace(/\D/g,"");
      window.open("https://wa.me/"+ph+"?text="+encodeURIComponent(fullMsg),"_blank");
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   BOOK NOW — for platform bookings (replace existing modals)
═══════════════════════════════════════════════════════════ */
function bookNow(opts, callback){
  /* Collect payment, then the webhook creates the booking + notifies both parties
     server-side (so a closed wizard can't lose the booking). */
  showGateway({
    providerName:  opts.providerName  || "Provider",
    category:      opts.category      || "default",
    serviceDesc:   opts.serviceDesc   || "Service Booking",
    providerPhone: opts.providerPhone || "",
    providerId:    opts.providerId    || "",
    bookingType:   "booking",
    onSuccess: function(ref){ if(callback) callback(ref); }
  });
}

/* ═══════════════════════════════════════════════════════════
   COLLECT REMAINING BALANCE — for deposit-only flows.
   Called when a service is marked complete. Triggers M-PESA
   STK for the remaining amount (total - deposit already paid).
   Commission is auto-deducted at this point too.
═══════════════════════════════════════════════════════════ */
function sendCommissionInvoice(ref, serviceTotal){
  /* Find the original fee record */
  const fees = getRecords("sokoniBookingFees");
  const fee  = fees.find(f=>f.ref===ref);
  const alreadyPaid = fee ? (fee.totalPaid||fee.depositAmount||0) : 0;
  const remaining   = Math.max(0, serviceTotal - alreadyPaid);

  const pct    = (fee&&fee.commissionPct) || SokoniCommission.pct("default");
  const sokCut = Math.round(remaining * pct / 100);
  const netPay = remaining - sokCut;

  /* Update commission ledger to "collected" */
  const ledger = getRecords("sokoniCommissionLedger");
  const entry  = ledger.find(e=>e.ref===ref);
  if(entry){
    entry.serviceTotal   = serviceTotal;
    entry.remainingPaid  = remaining;
    entry.sokoniCut      = (entry.sokoniCut||0) + sokCut;
    entry.providerNet    = (entry.providerNet||0) + netPay;
    entry.status         = "collected";
    entry.completedAt    = Date.now();
  } else {
    ledger.unshift({ref, sokoniCut:sokCut, providerNet:netPay, pct, serviceTotal, status:"collected", createdAt:Date.now()});
  }
  saveRecords("sokoniCommissionLedger", ledger);

  return { ref, sokoniCut:sokCut, providerNet:netPay, pct, remaining };
}

/* ═══════════════════════════════════════════════════════════
   REVEAL PHONE — unlock provider contact number for a fee
   Channel: Call Lead
═══════════════════════════════════════════════════════════ */
function revealPhone(opts, callback){
  /*
    opts = { providerName, category, phone, serviceDesc }
    Shows payment gate; on success reveals the phone number to the user.
  */
  const fee = SERVICE_FEES.phoneLead[opts.category] || SERVICE_FEES.phoneLead.default;
  showGateway({
    providerName:  opts.providerName || "Service Provider",
    category:      opts.category     || "default",
    serviceDesc:   opts.serviceDesc  || "Unlock direct contact number",
    depositAmount: fee,
    onSuccess: function(ref){
      const record = {
        ref, fee,
        providerName: opts.providerName,
        category:     opts.category || "default",
        unlockedPhone:opts.phone,
        status:"paid", createdAt:Date.now()
      };
      const records = getRecords("sokoniPhoneLeads");
      records.unshift(record);
      saveRecords("sokoniPhoneLeads", records);
      if(callback) callback(opts.phone, ref);
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   PLATFORM BOOK — full escrow booking (BnB, Ride)
   Channel: Platform-Native Booking
═══════════════════════════════════════════════════════════ */
function platformBook(opts){
  /*
    opts = {
      providerName, category, serviceDesc,
      totalAmount, depositPct (0–100, default 50),
      providerPhone, bookingDetails,
      onSuccess(ref, depositPaid, balanceDue)
    }
    SOKONI holds deposit in escrow; releases after service confirmation.
    Platform earns its % on the total — not just the deposit.
  */
  const depositPct   = (opts.depositPct !== undefined) ? opts.depositPct : 50;
  const total        = opts.totalAmount || 0;
  const deposit      = Math.round(total * depositPct / 100);
  const platformPct  = SokoniCommission.pct(opts.category);
  const platformFee  = Math.round(total * platformPct / 100);

  showGateway({
    providerName:  opts.providerName  || "Provider",
    category:      opts.category      || "default",
    serviceDesc:   opts.serviceDesc   || "Platform Booking",
    depositAmount: deposit,
    providerPhone: opts.providerPhone || "",
    onSuccess: function(ref){
      const record = {
        ref,
        providerName:   opts.providerName,
        category:       opts.category || "default",
        totalAmount:    total,
        depositPaid:    deposit,
        balanceDue:     total - deposit,
        platformPct,
        platformFee,
        providerEarns:  total - platformFee,
        bookingDetails: opts.bookingDetails || {},
        providerPhone:  opts.providerPhone || "",
        status:         "confirmed",
        createdAt:      Date.now()
      };
      const bookings = getRecords("sokoniPlatformBookings");
      bookings.unshift(record);
      saveRecords("sokoniPlatformBookings", bookings);
      // Log the platform fee portion as earned revenue
      saveBookingFee({
        ref, providerName:opts.providerName, category:opts.category||"default",
        depositAmount: platformFee, commissionPct: platformPct,
        phone:"", providerPhone:opts.providerPhone||"",
        serviceDesc: opts.serviceDesc||"", status:"paid", createdAt:Date.now()
      });
      if(opts.onSuccess) opts.onSuccess(ref, deposit, total - deposit);
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   CHARGE LEAD — provider-side RFQ / lead connection fee
   Channel: Lead Match (B2B, Banking, Insurance)
═══════════════════════════════════════════════════════════ */
function chargeLead(opts){
  /*
    opts = {
      providerName, category, serviceDesc, providerPhone,
      clientName, clientPhone, leadDetails,
      onSuccess(ref)
    }
    Charged to the PROVIDER when SOKONI delivers a qualified lead/RFQ.
  */
  const fee = SERVICE_FEES.leadFee[opts.category] || SERVICE_FEES.leadFee.default;
  showGateway({
    providerName:  opts.providerName || "Provider",
    category:      opts.category     || "default",
    serviceDesc:   "New Lead: " + (opts.clientName||"Buyer") + " — " + (opts.serviceDesc||"Service Request"),
    depositAmount: fee,
    providerPhone: opts.providerPhone || "",
    onSuccess: function(ref){
      const record = {
        ref, fee,
        providerName: opts.providerName,
        category:     opts.category || "default",
        clientName:   opts.clientName  || "",
        clientPhone:  opts.clientPhone || "",
        leadDetails:  opts.leadDetails || {},
        providerPhone:opts.providerPhone || "",
        status:"paid", createdAt:Date.now()
      };
      const leads = getRecords("sokoniLeadFees");
      leads.unshift(record);
      saveRecords("sokoniLeadFees", leads);
      saveBookingFee({
        ref, providerName:opts.providerName, category:opts.category||"default",
        depositAmount:fee, phone:"",
        providerPhone:opts.providerPhone||"",
        serviceDesc:"Lead fee", status:"paid", createdAt:Date.now()
      });
      if(opts.onSuccess) opts.onSuccess(ref);
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   VOUCHER — walk-in referral code system
   Channel: Walk-In / In-Person Referral
═══════════════════════════════════════════════════════════ */
function issueVoucher(opts){
  /*
    opts = { providerName, category, serviceDesc, providerPhone, onSuccess(ref, code) }
    Customer pays a small deposit → receives a voucher code to present at the provider.
    Provider redeems code → SOKONI invoices provider for a completion commission.
  */
  const dep = SERVICE_FEES.deposits[opts.category] || SERVICE_FEES.deposits.default;
  showGateway({
    providerName:  opts.providerName || "Provider",
    category:      opts.category     || "default",
    serviceDesc:   opts.serviceDesc  || "Get Walk-In Voucher",
    depositAmount: dep,
    providerPhone: opts.providerPhone || "",
    onSuccess: function(ref){
      const code = "V-" + ref;
      const record = {
        ref, code,
        providerName:  opts.providerName,
        category:      opts.category || "default",
        depositPaid:   dep,
        providerPhone: opts.providerPhone || "",
        status:        "issued",   // issued → redeemed → invoiced
        createdAt:     Date.now()
      };
      const vouchers = getRecords("sokoniVouchers");
      vouchers.unshift(record);
      saveRecords("sokoniVouchers", vouchers);
      if(opts.onSuccess) opts.onSuccess(ref, code);
    }
  });
}

function redeemVoucher(code){
  /* Called by provider after customer presents the voucher code. */
  const vouchers = getRecords("sokoniVouchers");
  const v = vouchers.find(v => v.code === code || v.ref === code);
  if(!v || v.status !== "issued") return null;
  v.status = "redeemed";
  v.redeemedAt = Date.now();
  saveRecords("sokoniVouchers", vouchers);
  saveCommissionObligation({
    ref:          v.ref,
    providerName: v.providerName,
    category:     v.category,
    commissionPct:SokoniCommission.pct(v.category),
    status:       "pending",
    serviceTotal: 0,
    commissionOwed: 0,
    providerPhone: v.providerPhone,
    note:         "Walk-in voucher redeemed — commission invoiced on completion",
    createdAt:    Date.now()
  });
  return v;
}

/* ═══════════════════════════════════════════════════════════
   PROPERTY CONNECT — tenant deposit + landlord deferred %
   Channel: Property Viewing Connection
═══════════════════════════════════════════════════════════ */
function propertyConnect(opts){
  /*
    opts = { landlordName, propertyDesc, landlordPhone, monthlyRent, onSuccess(ref) }
    Tenant pays KES 500 connection deposit.
    SOKONI defers a 2% invoice to the landlord after lease is signed.
  */
  const deposit     = SERVICE_FEES.deposits["property"] || 500;
  const platformPct = SokoniCommission.pct("property");
  showGateway({
    providerName:  opts.landlordName  || "Property Owner",
    category:      "property",
    serviceDesc:   opts.propertyDesc  || "Property Viewing — Connect with Landlord",
    depositAmount: deposit,
    providerPhone: opts.landlordPhone || "",
    onSuccess: function(ref){
      const commissionOwed = opts.monthlyRent ? Math.round(opts.monthlyRent * platformPct / 100) : 0;
      const record = {
        ref,
        landlordName:  opts.landlordName,
        propertyDesc:  opts.propertyDesc,
        landlordPhone: opts.landlordPhone,
        monthlyRent:   opts.monthlyRent || 0,
        tenantDeposit: deposit,
        platformPct,
        commissionOwed,
        status:        "viewing-scheduled",
        createdAt:     Date.now()
      };
      const connects = getRecords("sokoniPropertyConnects");
      connects.unshift(record);
      saveRecords("sokoniPropertyConnects", connects);
      if(commissionOwed > 0){
        saveCommissionObligation({
          ref, providerName:opts.landlordName,
          category:      "property",
          commissionPct: platformPct,
          status:        "pending",
          serviceTotal:  opts.monthlyRent || 0,
          commissionOwed,
          providerPhone: opts.landlordPhone || "",
          note:          platformPct+"% of first month rent — invoiced after lease signed",
          createdAt:     Date.now()
        });
      }
      if(opts.onSuccess) opts.onSuccess(ref);
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   SUBSCRIPTION GATE — check if provider is on a paid plan
═══════════════════════════════════════════════════════════ */
async function getProviderPlan(providerId){
  /* Delegate to SokoniSubscriptions if available (Firestore-backed) */
  if(window.SokoniSubscriptions){
    return window.SokoniSubscriptions.getProviderPlan(providerId);
  }
  /* Fallback: free (safe default — never returns an elevated plan from localStorage) */
  return "free";
}

function savePlanSubscription(providerId, plan){
  /* localStorage plan storage disabled — use SokoniSubscriptions.activateSubscription() */
  if(window.SokoniLogger) window.SokoniLogger.warn("savePlanSubscription via localStorage is disabled. Use activateSubscription().");
}

/* ═══════════════════════════════════════════════════════════
   BOOST / FEATURE LISTING
═══════════════════════════════════════════════════════════ */
const BOOST_PRICES = {
  basic:    { label:"Basic Boost",         price:200,  duration:7,  description:"Move listing to top of category" },
  premium:  { label:"Premium Featured",    price:500,  duration:7,  description:"Featured card with highlight + badge" },
  homepage: { label:"Homepage Feature",    price:2000, duration:7,  description:"Featured on SOKONI homepage" },
  urgent:   { label:"Urgent Listing Badge",price:100,  duration:3,  description:"'Urgent' badge for 3 days" },
};

async function boostListing(listingId, boostType, opts){
  const boost = BOOST_PRICES[boostType]; if(!boost) return;
  opts = opts || {};
  /* Server-authoritative (Slice 5A): the amount is minted by createPaymentIntent (purpose:'boost')
     from the SERVER price map, NOT this client BOOST_PRICES table; the STK enforces the server intent
     amount, so a tampered client cannot set the price. No localStorage "boost active" grant — a client
     must not establish that a boost was purchased or activated; the record is paymentIntents/{ref}. */
  const call = (typeof window!=="undefined" && typeof window.sokoniCallable==="function") ? window.sokoniCallable : null;
  if(!call){ (window._skToast||window.alert||function(){})("Payments are unavailable right now. Please try again shortly."); return; }
  let _intent = null;
  try {
    const _r = await call('createPaymentIntent')({ purpose:'boost', boostKey:boostType, listingId:listingId });
    _intent = _r && _r.data;
  } catch(e){ (window._skToast||window.alert)("Could not start boost payment: "+((e&&e.message)||'please try again.')); return; }
  if(!_intent || !_intent.ref){ (window._skToast||window.alert)("Could not start boost payment. Please try again."); return; }
  showGateway({
    providerName:  opts.listingName || "Your Listing",
    category:      "boost",
    serviceDesc:   boost.label+" — "+boost.description+" ("+boost.duration+" days)",
    depositAmount: _intent.amount,
    paymentIntentId: _intent.ref,
    ref: _intent.ref,
    onSuccess: function(ref){
      /* Settled payment only. The purchase is recorded server-side (paymentIntents/{ref}); the boost's
         ranking effect is a separate server-side entitlement slice, not established by this client. */
      (window._skToast||window.alert)("✅ "+boost.label+" purchased — payment confirmed. Ref: "+ref);
    }
  });
}

/* ═══════════════════════════════════════════════════════════
   ANALYTICS HELPERS (for admin commission dashboard)
═══════════════════════════════════════════════════════════ */
function getRevenueStats(){
  const fees        = getRecords("sokoniBookingFees");
  const ledger      = getRecords("sokoniCommissionLedger");
  /* legacy key still in use on some installs */
  const obligations = getRecords("sokoniCommissionObligation");
  const phoneLeads  = getRecords("sokoniPhoneLeads");
  const leadFees    = getRecords("sokoniLeadFees");
  const bookings    = getRecords("sokoniPlatformBookings");
  const vouchers    = getRecords("sokoniVouchers");
  const propConnects= getRecords("sokoniPropertyConnects");

  const today = new Date().toISOString().split("T")[0];
  const todayFees = fees.filter(f=>new Date(f.createdAt).toISOString().startsWith(today));

  /* Revenue = total collected through SOKONI (auto-cut model) */
  const feeCollected = r => r.totalPaid||r.depositAmount||r.amount||0;
  const byCat = {};
  fees.forEach(f=>{ byCat[f.category]=(byCat[f.category]||0)+feeCollected(f); });

  /* Commission actually collected (auto_collected + collected records) */
  const commissionCollected = ledger
    .filter(r=>r.status==="auto_collected"||r.status==="collected")
    .reduce((s,r)=>s+(r.sokoniCut||0),0);

  const phoneLeadTotal  = phoneLeads.reduce((s,r)=>s+(r.fee||0),0);
  const leadFeeTotal    = leadFees.reduce((s,r)=>s+(r.fee||0),0);
  const platformFeeTotal= bookings.reduce((s,r)=>s+(r.platformFee||0),0);
  const voucherTotal    = vouchers.filter(v=>v.status!=="issued").reduce((s,v)=>s+(v.depositPaid||0),0);
  const propTotal       = propConnects.reduce((s,r)=>s+(r.tenantDeposit||0),0);

  return {
    totalRevenue:         fees.reduce((s,f)=>s+feeCollected(f),0),
    todayRevenue:         todayFees.reduce((s,f)=>s+feeCollected(f),0),
    commissionCollected,
    totalTransactions:    fees.length,
    todayTransactions:    todayFees.length,
    commissionOwed:       obligations.filter(o=>o.status==="invoiced").reduce((s,o)=>s+(o.commissionOwed||0),0),
    commissionPending:    obligations.filter(o=>o.status==="pending").length,
    byCategory:           byCat,
    avgDepositValue:      fees.length ? Math.round(fees.reduce((s,f)=>s+(f.depositAmount||0),0)/fees.length) : 0,
    // Multi-channel breakdown
    channels: {
      whatsappGate:   fees.filter(f=>f.category!=="boost").reduce((s,f)=>s+(f.depositAmount||0),0),
      phoneLeads:     phoneLeadTotal,
      leadFees:       leadFeeTotal,
      platformBooks:  platformFeeTotal,
      vouchers:       voucherTotal,
      propertyConns:  propTotal,
      boosts:         fees.filter(f=>f.category==="boost").reduce((s,f)=>s+(f.depositAmount||0),0),
    }
  };
}

/* ═══════════════════════════════════════════════════════════
   SEED DEMO DATA (so admin shows revenue from day one)
═══════════════════════════════════════════════════════════ */
function seedDemoRevenue(){
  if(localStorage.getItem("sokoniPaySeeded")) return;

  // WhatsApp Gate + Checkout bookings
  const cats = ["legal","healthcare","entertainment","car-rental","default","hair-beauty","plumbing","sports","construction","photography","catering"];
  const providers = ["Advocate Grace Wanjiku","Dr. Brian Omondi","DJ BVMBXNO","Toyota Land Cruiser Rental","Kevin Njoroge Barber","Peter Kamau Plumbing","Westlands FC Turf","Bamburi Cement","Victor Osei Photography","Mama Rose Catering","Coach Brian Maina PT"];
  const fees=[], obligations=[];
  for(let i=0;i<120;i++){
    const cat = cats[i%cats.length];
    const dep = SERVICE_FEES.deposits[cat]||200;
    const pct = SokoniCommission.pct(cat);
    const ref = "SKN"+(100000+i).toString(36).toUpperCase();
    const daysAgo = Math.floor(Math.random()*30);
    const ts = Date.now() - daysAgo*86400000 - Math.random()*43200000;
    fees.push({ ref, providerName:providers[i%providers.length], category:cat, depositAmount:dep, commissionPct:pct, phone:"07"+Math.floor(10000000+Math.random()*89999999), status:"paid", createdAt:ts });
    if(Math.random()>0.4){
      const total = dep*10 + Math.round(Math.random()*dep*20);
      obligations.push({ ref, providerName:providers[i%providers.length], category:cat, commissionPct:pct, serviceTotal:total, commissionOwed:Math.round(total*pct/100), status:Math.random()>0.5?"invoiced":"pending", createdAt:ts });
    }
  }
  saveRecords("sokoniBookingFees", fees);
  saveRecords("sokoniCommissionObligation", obligations);

  // Phone Lead unlocks
  const phoneLeadCats = ["property","legal","healthcare","b2b","hair-beauty"];
  const phoneLeadProvs = ["James Mwangi Landlord","Advocate Grace Wanjiku","Dr. Amina Hassan","Nairobi Wholesale Ltd","Lavish Hair & Beauty"];
  const phoneLeads = [];
  for(let i=0;i<30;i++){
    const cat = phoneLeadCats[i%phoneLeadCats.length];
    const fee = SERVICE_FEES.phoneLead[cat]||100;
    const ts = Date.now() - Math.floor(Math.random()*30)*86400000;
    phoneLeads.push({ ref:"PHL"+(10000+i).toString(36).toUpperCase(), fee, providerName:phoneLeadProvs[i%phoneLeadProvs.length], category:cat, unlockedPhone:"07"+Math.floor(10000000+Math.random()*89999999), status:"paid", createdAt:ts });
  }
  saveRecords("sokoniPhoneLeads", phoneLeads);

  // Lead Fees (B2B / Banking)
  const leadProviders = ["Nairobi Wholesale Ltd","KCB SME Banking","Equity Bank Loans","Jumia Wholesale","Equity Bank Loans"];
  const leadFees = [];
  for(let i=0;i<20;i++){
    const cat = i%2===0?"b2b":"banking";
    const fee = SERVICE_FEES.leadFee[cat]||300;
    const ts = Date.now() - Math.floor(Math.random()*30)*86400000;
    leadFees.push({ ref:"LDF"+(10000+i).toString(36).toUpperCase(), fee, providerName:leadProviders[i%leadProviders.length], category:cat, clientName:"Buyer "+(i+1), status:"paid", createdAt:ts });
  }
  saveRecords("sokoniLeadFees", leadFees);

  // Platform Bookings (BnB / Ride)
  const bnbProviders = ["Nairobi Airbnb Westlands","Mombasa Beach House","Kisumu Lakeside Stay"];
  const platformBookings = [];
  for(let i=0;i<25;i++){
    const cat = i%3===0?"ride":"bnb";
    const total = cat==="bnb" ? 3000+Math.round(Math.random()*7000) : 300+Math.round(Math.random()*500);
    const pct = SokoniCommission.pct(cat);
    const ts = Date.now() - Math.floor(Math.random()*30)*86400000;
    platformBookings.push({ ref:"PLB"+(10000+i).toString(36).toUpperCase(), providerName:cat==="bnb"?bnbProviders[i%3]:"Driver "+i, category:cat, totalAmount:total, depositPaid:Math.round(total*0.5), balanceDue:Math.round(total*0.5), platformPct:pct, platformFee:Math.round(total*pct/100), providerEarns:total-Math.round(total*pct/100), status:"confirmed", createdAt:ts });
    fees.push({ ref:"PLB"+(10000+i).toString(36).toUpperCase(), providerName:cat==="bnb"?bnbProviders[i%3]:"Driver "+i, category:cat, depositAmount:Math.round(total*pct/100), commissionPct:pct, phone:"", providerPhone:"", serviceDesc:cat+" booking", status:"paid", createdAt:ts });
  }
  saveRecords("sokoniPlatformBookings", platformBookings);

  // Vouchers (walk-in)
  const voucherProvs = ["Mama Rose Catering","Nairobi Barbers","Coast Gym","City Pharmacy"];
  const voucherRecs = [];
  for(let i=0;i<15;i++){
    const cat = ["catering","hair-beauty","fitness","healthcare"][i%4];
    const dep = SERVICE_FEES.deposits[cat]||200;
    const statuses = ["issued","redeemed","redeemed","invoiced"];
    const ts = Date.now() - Math.floor(Math.random()*30)*86400000;
    voucherRecs.push({ ref:"VCH"+(10000+i).toString(36).toUpperCase(), code:"V-VCH"+(10000+i).toString(36).toUpperCase(), providerName:voucherProvs[i%4], category:cat, depositPaid:dep, status:statuses[i%4], createdAt:ts });
  }
  saveRecords("sokoniVouchers", voucherRecs);

  // Property connects
  const propLandlords = ["James Mwangi","Nairobi Homes Ltd","Westlands Properties","Coast Realty"];
  const propConnects = [];
  for(let i=0;i<12;i++){
    const rent = 15000+Math.round(Math.random()*45000);
    const pct = SokoniCommission.pct("property");
    const ts = Date.now() - Math.floor(Math.random()*30)*86400000;
    propConnects.push({ ref:"PRP"+(10000+i).toString(36).toUpperCase(), landlordName:propLandlords[i%4], propertyDesc:["1BR Westlands","2BR Kilimani","Bedsitter Kasarani","3BR Mombasa"][i%4], monthlyRent:rent, tenantDeposit:500, platformPct:pct, commissionOwed:Math.round(rent*pct/100), status:"viewing-scheduled", createdAt:ts });
  }
  saveRecords("sokoniPropertyConnects", propConnects);

  localStorage.setItem("sokoniPaySeeded","1");
}

/* ═══════════════════════════════════════════════════════════
   HELPER: get logged-in user phone
═══════════════════════════════════════════════════════════ */
function _getLoggedInPhone(){
  try{ const u=JSON.parse(localStorage.getItem("sokoniUser")||"null"); return u?.phone||""; }catch(e){ return ""; }
}

/* ═══════════════════════════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════════════════════════ */
const SokoniPay = {
  // ── Core channels ──────────────────────────────────────────
  gateway:              showGateway,
  waConnect:            waConnect,           // WhatsApp Gate
  bookNow:              bookNow,             // On-platform booking
  // ── Multi-channel additions ────────────────────────────────
  revealPhone:          revealPhone,         // Call Lead: unlock contact number
  platformBook:         platformBook,        // Platform-Native: BnB / Ride escrow
  chargeLead:           chargeLead,          // Lead Match: B2B / Banking RFQ fee
  issueVoucher:         issueVoucher,        // Walk-In: issue referral voucher
  redeemVoucher:        redeemVoucher,       // Walk-In: provider redeems code
  propertyConnect:      propertyConnect,     // Property: tenant deposit + landlord %
  // ── Post-completion ────────────────────────────────────────
  sendCommissionInvoice:sendCommissionInvoice,
  // ── Direct ledger writes (for hub pages that have own payment flows) ──
  saveCommission:       saveCommissionRecord,
  saveFee:              saveBookingFee,
  // ── Subscriptions & Boosts ─────────────────────────────────
  boostListing:         boostListing,
  getProviderPlan:      getProviderPlan,
  savePlanSubscription: savePlanSubscription,
  // ── Admin / Analytics ──────────────────────────────────────
  getRevenueStats:      getRevenueStats,  SERVICE_FEES,
  COMMISSION_RATES: SERVICE_FEES, /* deprecated alias — flat fees only; percentages live in SokoniCommission */
  PLANS,
  BOOST_PRICES,
  seedDemoRevenue,
};

global.SokoniPay = SokoniPay;

/* seedDemoRevenue() is available for manual dev use only — NOT auto-run in production */

})(window);
