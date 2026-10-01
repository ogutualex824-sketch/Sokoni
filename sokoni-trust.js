/* ================================================================
   SOKONI TRUST ENGINE — sokoni-trust.js
   SokoniReport · SokoniOnboarding · SokoniDispute
   SokoniFraud · SokoniHelp
   IIFE — exposes globals, no ES module syntax
================================================================ */
(function (window) {
  'use strict';

  /* ── Utility ── */
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  function showToast(msg, type) {
    type = type || 'success';
    var existing = document.getElementById('sokoni-trust-toast');
    if (existing) existing.remove();
    var t = document.createElement('div');
    t.id = 'sokoni-trust-toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    t.style.cssText = [
      'position:fixed', 'bottom:90px', 'left:50%', 'transform:translateX(-50%)',
      'background:' + (type === 'error' ? 'rgba(255,60,60,0.95)' : 'rgba(113,255,0,0.95)'),
      'color:' + (type === 'error' ? '#fff' : '#0a0a0a'),
      'padding:13px 22px', 'border-radius:14px', 'font-size:14px', 'font-weight:700',
      'z-index:99999', 'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
      'max-width:320px', 'text-align:center', 'pointer-events:none'
    ].join(';');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3500);
  }

  function getDB() {
    return window.firebaseDB || null;
  }

  function getUID() {
    var auth = window.firebaseAuth;
    if (auth && auth.currentUser) return auth.currentUser.uid;
    return null;
  }

  async function firestoreImport() {
    return await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  }

  /* ================================================================
     window.SokoniReport
     ONE report authority (community C2, 2026-10-01): every report goes to the server callable tsReportContent
     (functions/trust-safety.js) — the `reports` store AdminOS, super admin and the seller's merchant-v2 read. The
     browser writes NO report store any more (it used to addDoc `flags`, which no admin workspace read).
     The reason list is the SERVER's (tsGetReportReasons) — there is no client copy to drift.
     A report is "sent" only when the server has answered; a refusal is returned / shown as the server's reason.
  ================================================================ */
  var _REPORT_REGION = 'us-central1';
  var _reasonCache = {};

  async function _reportCallable(name) {
    /* the page's own app + App Check (firebase.js / sokoni-init.js) — wait for both instead of racing them */
    for (var i = 0; i < 60 && !window.firebaseApp; i++) await new Promise(function (r) { setTimeout(r, 100); });
    var app = window.firebaseApp || null;
    if (!app) {
      /* a page that started its own app without firebase.js — use it rather than starting a second one */
      try { var A = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'); app = A.getApps()[0] || null; } catch (_) { app = null; }
    }
    if (!app) throw Object.assign(new Error('SOKONI is still starting — try again in a moment.'), { code: 'unavailable' });
    if (window.__sokoniAppCheckReady && typeof window.__sokoniAppCheckReady.then === 'function') { try { await window.__sokoniAppCheckReady; } catch (_) {} }
    var Fn = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    var fns = (window.firebaseApp && window.firebaseFunctions) || Fn.getFunctions(app, _REPORT_REGION);
    return Fn.httpsCallable(fns, name);
  }
  async function _reportUser() {
    if (typeof window.waitForSokoniAuthReady === 'function') { try { await window.waitForSokoniAuthReady(); } catch (_) {} }
    var a = window.firebaseAuth;
    return (a && a.currentUser) || null;
  }
  function _reportErr(err) {
    var code = String((err && err.code) || '').replace(/^functions\//, '');
    var msg = err && err.message ? String(err.message).replace(/^FirebaseError:\s*/, '') : '';
    if (!msg || /^internal$/i.test(msg)) msg = 'The report could not be sent. Please try again.';
    return { ok: false, code: code || 'unknown', message: msg };
  }

  window.SokoniReport = {
    currentUser: _reportUser,

    /* → { ok:true, reasons:[{code,label,hint,detailRequired}], freeText, detailMax, detailMinWhenRequired }
       | { ok:false, code, message } — never a client-made list */
    reasons: async function (entityType) {
      var key = String(entityType || '');
      if (_reasonCache[key]) return _reasonCache[key];
      try {
        var r = await (await _reportCallable('tsGetReportReasons'))({ entityType: key });
        var d = (r && r.data) || {};
        if (!Array.isArray(d.reasons)) return { ok: false, code: 'bad-response', message: 'The list of reasons could not be loaded.' };
        var out = { ok: true, entityType: d.entityType || key, reasons: d.reasons, freeText: d.freeText === true,
          detailMax: Number(d.detailMax) || 500, detailMinWhenRequired: Number(d.detailMinWhenRequired) || 10 };
        _reasonCache[key] = out;
        return out;
      } catch (err) { return _reportErr(err); }
    },

    /* the structured call the wizard uses: no toasts, no navigation — the caller renders the outcome.
       → { ok:true, reportId, status } | { ok:false, code, message } */
    send: async function (entityType, entityId, reasonCode, detail, evidenceUrls) {
      var user = await _reportUser();
      if (!user) return { ok: false, code: 'unauthenticated', message: 'Sign in to report.' };
      var payload = {
        entityType: String(entityType || ''),
        entityId: String(entityId || '').slice(0, 128),
        reasonCode: String(reasonCode || '').slice(0, 120),
        detail: String(detail || '').slice(0, 500),
        evidenceUrls: (evidenceUrls || []).filter(function (u) { return typeof u === 'string' && u.indexOf('https://') === 0; }).slice(0, 5)
      };
      try {
        var r = await (await _reportCallable('tsReportContent'))(payload);
        var d = (r && r.data) || {};
        if (!d.reportId) return { ok: false, code: 'bad-response', message: 'The server did not confirm the report.' };
        return { ok: true, reportId: d.reportId, status: d.status || 'pending' };
      } catch (err) { return _reportErr(err); }
    },

    /* Historical entry point (seller-public.html): free-text reason types. Same authority; shows the outcome as a
       toast and resolves null when NOT sent, so a caller never closes its form on a failure. */
    submit: async function (type, targetId, reason, details, evidenceUrls) {
      var user = await _reportUser();
      if (!user) {
        showToast('Sign in to submit a report.', 'error');
        setTimeout(function () { window.location.href = 'login.html?next=' + encodeURIComponent(location.pathname + location.search); }, 1200);
        return null;
      }
      if (!reason) { showToast('Please select a reason.', 'error'); return null; }
      var payload = {
        entityType: String(type || ''),
        entityId: String(targetId || '').slice(0, 128),
        reason: String(reason).slice(0, 120),
        detail: String(details || '').slice(0, 500),
        evidenceUrls: (evidenceUrls || []).filter(function (u) { return typeof u === 'string' && u.indexOf('https://') === 0; }).slice(0, 5)
      };
      try {
        var r = await (await _reportCallable('tsReportContent'))(payload);
        var d = (r && r.data) || {};
        if (!d.reportId) throw new Error('The server did not confirm the report.');
        showToast('Report received — SOKONI will review it. Thank you.');
        return d;
      } catch (err) {
        var e = _reportErr(err);
        showToast(e.code === 'already-exists' ? 'You have already reported this — our team is reviewing it.'
          : 'Your report was NOT sent: ' + e.message, 'error');
        return null;
      }
    }
  };

  /* ================================================================
     window.SokoniOnboarding
  ================================================================ */
  window.SokoniOnboarding = {
    _key: function (role) { return 'sokoniOnboarding_' + role; },

    getState: function (role) {
      try {
        var raw = localStorage.getItem(this._key(role));
        return raw ? JSON.parse(raw) : { step: 0, data: {}, completed: false };
      } catch (e) {
        return { step: 0, data: {}, completed: false };
      }
    },

    setState: function (role, state) {
      try {
        localStorage.setItem(this._key(role), JSON.stringify(state));
      } catch (e) {}
    },

    setStep: function (role, step, data) {
      var state = this.getState(role);
      state.step = step;
      if (data && typeof data === 'object') {
        state.data = Object.assign({}, state.data, data);
      }
      this.setState(role, state);
      return state;
    },

    complete: async function (role) {
      var state = this.getState(role);
      state.completed = true;
      this.setState(role, state);
      try {
        var db = getDB();
        var uid = getUID();
        if (db && uid) {
          var fs = await firestoreImport();
          var col = fs.collection(db, 'onboardingCompleted');
          await fs.addDoc(col, {
            role:        role,
            uid:         uid,
            data:        state.data,
            completedAt: new Date().toISOString()
          });
        }
      } catch (err) {
        console.error('[SokoniOnboarding.complete]', err);
      }
      return state;
    },

    getProgress: function (role, totalSteps) {
      var state = this.getState(role);
      if (state.completed) return 100;
      if (!totalSteps || totalSteps < 1) return 0;
      return Math.round((state.step / totalSteps) * 100);
    }
  };

  /* ================================================================
     window.SokoniDispute
  ================================================================ */
  window.SokoniDispute = {
    open: async function (disputeData) {
      var uid = getUID();
      if (!uid) {
        showToast('Sign in to open a dispute.', 'error');
        setTimeout(function () { window.location.href = 'login.html?next=' + encodeURIComponent(location.pathname + location.search); }, 1200);
        return null;
      }
      if (!disputeData.orderId || !disputeData.reason) {
        showToast('Order ID and reason are required.', 'error');
        return null;
      }
      var doc = Object.assign({}, disputeData, {
        uid:       uid,
        status:    'open',
        createdAt: new Date().toISOString(),
        createdBy: uid,
        messages:  [],
        evidence:  []
      });
      try {
        var db = getDB();
        if (!db) throw new Error('No DB');
        var fs = await firestoreImport();
        var ref = await fs.addDoc(fs.collection(db, 'disputes'), doc);
        showToast('Dispute opened. Reference: ' + ref.id.slice(0, 8).toUpperCase());
        return ref.id;
      } catch (err) {
        console.error('[SokoniDispute.open]', err);
        showToast('Could not open dispute. Try again.', 'error');
        return null;
      }
    },

    addEvidence: async function (disputeId, evidenceUrl, label) {
      /* Validate URL — only allow https:// to prevent javascript: injection */
      if (typeof evidenceUrl !== 'string' || !evidenceUrl.startsWith('https://')) {
        showToast('Invalid evidence URL. Only secure HTTPS links allowed.', 'error');
        return;
      }
      if (!getUID()) { showToast('Sign in to add evidence.', 'error'); return; }
      try {
        var db = getDB();
        if (!db) throw new Error('No DB');
        var fs = await firestoreImport();
        var ref = fs.doc(db, 'disputes', disputeId);
        await fs.updateDoc(ref, {
          evidence: fs.arrayUnion({
            url:     evidenceUrl,
            label:   String(label || '').slice(0, 100),
            addedAt: new Date().toISOString(),
            addedBy: getUID()
          })
        });
        showToast('Evidence added.');
      } catch (err) {
        console.error('[SokoniDispute.addEvidence]', err);
        showToast('Failed to add evidence.', 'error');
      }
    },

    sendMessage: async function (disputeId, message, senderUid, senderName) {
      var uid = getUID();
      if (!uid) { showToast('Sign in to send a message.', 'error'); return; }
      /* Hard length cap — Firestore rule also enforces 2000 chars */
      var msg = String(message || '').trim().slice(0, 2000);
      if (!msg) { showToast('Message cannot be empty.', 'error'); return; }
      try {
        var db = getDB();
        if (!db) throw new Error('No DB');
        var fs = await firestoreImport();
        var msgCol = fs.collection(db, 'disputes', disputeId, 'messages');
        await fs.addDoc(msgCol, {
          message:    msg,
          senderUid:  uid,
          senderName: String(senderName || 'User').slice(0, 60),
          sentAt:     new Date().toISOString()
        });
      } catch (err) {
        console.error('[SokoniDispute.sendMessage]', err);
        showToast('Message failed to send.', 'error');
      }
    },

    listen: async function (disputeId, callback) {
      try {
        var db = getDB();
        if (!db) return function () {};
        var fs = await firestoreImport();
        var ref = fs.doc(db, 'disputes', disputeId);
        return fs.onSnapshot(ref, function (snap) {
          callback(snap.exists() ? Object.assign({ id: snap.id }, snap.data()) : null);
        });
      } catch (err) {
        console.error('[SokoniDispute.listen]', err);
        return function () {};
      }
    },

    requestRefund: async function (disputeId, amount, reason) {
      /* Verify caller is party to this dispute before writing */
      var uid = getUID();
      if (!uid) {
        showToast('Sign in to request a refund.', 'error');
        return;
      }
      var parsedAmount = parseFloat(amount);
      if (!parsedAmount || parsedAmount <= 0) {
        showToast('Enter a valid refund amount.', 'error');
        return;
      }
      try {
        var db = getDB();
        if (!db) throw new Error('No DB');
        var fs = await firestoreImport();
        var ref = fs.doc(db, 'disputes', disputeId);
        /* Read dispute first — confirm caller is the buyer/uid owner */
        var snap = await fs.getDoc(ref);
        if (!snap.exists()) { showToast('Dispute not found.', 'error'); return; }
        var d = snap.data();
        if (d.uid !== uid && d.buyerUid !== uid) {
          showToast('You are not authorised to request a refund on this dispute.', 'error');
          return;
        }
        await fs.updateDoc(ref, {
          refundRequested:   true,
          refundAmount:      parsedAmount,
          refundReason:      String(reason || '').slice(0, 500),
          refundRequestedAt: new Date().toISOString()
        });
        showToast('Refund request submitted.');
      } catch (err) {
        console.error('[SokoniDispute.requestRefund]', err);
        showToast('Refund request failed.', 'error');
      }
    },

    close: async function (disputeId, resolution) {
      /* admin only — UI enforces, Firestore rules enforce */
      try {
        var db = getDB();
        if (!db) throw new Error('No DB');
        var fs = await firestoreImport();
        var ref = fs.doc(db, 'disputes', disputeId);
        await fs.updateDoc(ref, {
          status:     'resolved',
          resolution: resolution || '',
          resolvedAt: new Date().toISOString()
        });
        showToast('Dispute closed.');
      } catch (err) {
        console.error('[SokoniDispute.close]', err);
        showToast('Failed to close dispute.', 'error');
      }
    }
  };

  /* ================================================================
     window.SokoniFraud
  ================================================================ */
  window.SokoniFraud = {
    flag: async function (targetId, targetType, reason, details) {
      var uid = getUID();
      var alert = {
        targetId:   String(targetId),
        targetType: String(targetType),
        reason:     String(reason),
        details:    String(details || ''),
        flaggedBy:  uid || 'system',
        flaggedAt:  new Date().toISOString(),
        status:     'pending',
        severity:   'medium'
      };
      try {
        var db = getDB();
        if (!db) throw new Error('No DB');
        var fs = await firestoreImport();
        await fs.addDoc(fs.collection(db, 'fraudAlerts'), alert);
        showToast('Fraud alert submitted for review.');
      } catch (err) {
        console.error('[SokoniFraud.flag]', err);
      }
      return alert;
    },

    checkNewAccount: function (createdAt) {
      if (!createdAt) return false;
      var created = new Date(createdAt).getTime();
      var sevenDays = 7 * 24 * 60 * 60 * 1000;
      return (Date.now() - created) < sevenDays;
    },

    checkPriceAnomaly: function (price, category) {
      var floors = {
        Electronics: 500,
        Fashion:     50,
        Food:        10,
        Home:        100,
        Beauty:      50,
        Sports:      100,
        Books:       20,
        Other:       10
      };
      var floor = floors[category] || 10;
      return price < floor || price > 10000000;
    },

    getAlerts: async function (callback) {
      try {
        var db = getDB();
        if (!db) return function () {};
        var fs = await firestoreImport();
        var q = fs.query(
          fs.collection(db, 'fraudAlerts'),
          fs.where('status', '==', 'pending'),
          fs.orderBy('flaggedAt', 'desc'),
          fs.limit(100)
        );
        return fs.onSnapshot(q, function (snap) {
          var items = [];
          snap.forEach(function (d) { items.push(Object.assign({ id: d.id }, d.data())); });
          callback(items);
        });
      } catch (err) {
        console.error('[SokoniFraud.getAlerts]', err);
        return function () {};
      }
    }
  };

  /* ================================================================
     window.SokoniHelp
  ================================================================ */
  window.SokoniHelp = {
    categories: ['Getting Started', 'Selling', 'Buying', 'Payments', 'Delivery', 'Safety', 'Disputes'],

    articles: [
      /* ── Getting Started ── */
      { id: 1,  category: 'Getting Started', title: 'How do I create a SOKONI account?', tags: ['account','register','sign up','create'], content: 'Visit mysokoni.co.ke and tap "Sign Up". Enter your phone number or email, set a password, then verify via OTP. Your account is ready instantly.' },
      { id: 2,  category: 'Getting Started', title: 'How do I complete my profile?', tags: ['profile','photo','name','bio'], content: 'Go to Profile → Edit Profile. Add a clear photo, your real name, county and a short bio. Complete profiles get 60% more trust from buyers and sellers.' },
      { id: 3,  category: 'Getting Started', title: 'What is SOKONI?', tags: ['about','marketplace','kenya','what'], content: 'SOKONI is Kenya\'s all-in-one marketplace for shopping, services, delivery, healthcare, entertainment and more. It connects buyers, sellers, drivers and professionals across Kenya.' },
      { id: 4,  category: 'Getting Started', title: 'How do I change my password?', tags: ['password','security','change','reset'], content: 'Go to Profile → Settings → Change Password. Enter your current password then your new password twice. Use at least 8 characters including a number.' },
      { id: 5,  category: 'Getting Started', title: 'How do I verify my phone number?', tags: ['verify','phone','otp','sms'], content: 'Go to Profile → Verification → Phone Number. Enter your Safaricom or Airtel number and tap "Send OTP". Enter the 6-digit code received via SMS.' },
      { id: 6,  category: 'Getting Started', title: 'Can I use SOKONI without an account?', tags: ['guest','browse','no account'], content: 'Yes — you can browse products and services as a guest. To buy, sell, or book services you need a free account.' },
      { id: 7,  category: 'Getting Started', title: 'How do I enable notifications?', tags: ['notifications','alerts','push'], content: 'When prompted, tap "Allow" to enable push notifications. You\'ll get alerts for order updates, messages and promotions. Manage in Profile → Settings → Notifications.' },
      { id: 8,  category: 'Getting Started', title: 'Is SOKONI free to join?', tags: ['free','cost','fee','membership'], content: 'Joining SOKONI is 100% free. Listing up to 10 products is free. For more listings, boosts and advanced features, upgrade to a SOKONI Pro plan.' },

      /* ── Selling ── */
      { id: 9,  category: 'Selling', title: 'How do I start selling on SOKONI?', tags: ['sell','seller','list','start'], content: 'Go to Seller Dashboard → tap "+ Add Product". Fill in the product name, price, category, description and photos. Tap "Publish" and your listing goes live instantly.' },
      { id: 10, category: 'Selling', title: 'How many products can I list for free?', tags: ['listings','limit','free','quota'], content: 'Free accounts can list up to 10 products. Upgrade to Pro (KES 499/month) for unlimited listings, boosted visibility and sales analytics.' },
      { id: 11, category: 'Selling', title: 'How do I add photos to my listing?', tags: ['photos','images','upload','pictures'], content: 'When creating a listing, tap the photo area to upload from your gallery. Use clear, bright photos. The first photo is your cover image. Add up to 8 photos per product.' },
      { id: 12, category: 'Selling', title: 'How do I get verified as a seller?', tags: ['verify','badge','trusted','seller'], content: 'To get the Verified Seller badge, go to Seller Dashboard → Verification. Submit your National ID and business documents. Approval takes 24–48 hours.' },
      { id: 13, category: 'Selling', title: 'How do I manage orders?', tags: ['orders','manage','confirm','dispatch'], content: 'All orders appear in Seller Dashboard → Orders. Tap an order to confirm it, update the status (Packing, Dispatched, Delivered), or message the buyer.' },
      { id: 14, category: 'Selling', title: 'What products are prohibited on SOKONI?', tags: ['prohibited','banned','illegal','weapons'], content: 'Prohibited items include: weapons and ammunition, drugs and controlled substances, counterfeit goods, stolen items, adult content, and live animals. Violations result in immediate ban.' },
      { id: 15, category: 'Selling', title: 'How do I boost my listings?', tags: ['boost','promote','visibility','ads'], content: 'In Seller Dashboard, tap any listing → "Boost Listing". Choose duration (3, 7 or 30 days) and pay via M-Pesa. Boosted listings appear at the top of search results.' },
      { id: 16, category: 'Selling', title: 'How do I withdraw my earnings?', tags: ['withdraw','earnings','payout','mpesa'], content: 'Go to Seller Dashboard → Wallet → Withdraw. Enter your M-Pesa number and amount. Minimum withdrawal is KES 100. Funds arrive within 30 seconds via M-Pesa.' },
      { id: 17, category: 'Selling', title: 'Can I sell services (not just products)?', tags: ['services','freelance','skills','gig'], content: 'Yes! Go to the Services section → Register as a Provider. Set your services, hourly rate, and availability. Clients can book and pay you directly through SOKONI.' },
      { id: 18, category: 'Selling', title: 'How does SOKONI commission work?', tags: ['commission','fee','percentage','charge'], content: 'SOKONI takes a small commission (5–10%) on completed sales. No fee until you earn. Commission details are shown in Seller Dashboard → Earnings.' },

      /* ── Buying ── */
      { id: 19, category: 'Buying', title: 'How do I place an order?', tags: ['buy','order','purchase','checkout'], content: 'Browse products, tap any item to view details, then tap "Buy Now" or "Add to Cart". Proceed to checkout, enter your delivery address, and pay via M-Pesa or card.' },
      { id: 20, category: 'Buying', title: 'Can I negotiate the price?', tags: ['negotiate','bargain','offer','price'], content: 'Yes! On any listing, tap "Message Seller" to discuss pricing. Many sellers are open to reasonable offers, especially on bulk orders.' },
      { id: 21, category: 'Buying', title: 'How do I track my order?', tags: ['track','delivery','status','where'], content: 'Go to Profile → My Orders, select your order and tap "Track Order". You\'ll see real-time status updates. If SOKONI delivery is used, you can track the rider on the map.' },
      { id: 22, category: 'Buying', title: 'What if the product is different from the listing?', tags: ['wrong','different','not as described','dispute'], content: 'Take photos immediately and open a dispute: Profile → Orders → [Order] → "Report a Problem". Select "Item not as described" and upload evidence. We\'ll mediate within 48 hours.' },
      { id: 23, category: 'Buying', title: 'How do I leave a review?', tags: ['review','rating','feedback','stars'], content: 'After your order is delivered, go to Profile → Orders → [Order] → "Leave Review". Rate 1-5 stars and write your experience. Honest reviews help the community.' },
      { id: 24, category: 'Buying', title: 'Can I return an item?', tags: ['return','refund','exchange','unwanted'], content: 'Returns depend on the seller\'s policy (shown on the listing). For SOKONI-guaranteed listings, you can request a return within 7 days if the item is faulty or not as described.' },
      { id: 25, category: 'Buying', title: 'How do I save items for later?', tags: ['wishlist','save','favourite','bookmark'], content: 'Tap the heart icon on any listing to save it to your Wishlist. Access your saved items anytime via Profile → Wishlist.' },

      /* ── Payments ── */
      { id: 26, category: 'Payments', title: 'How do I pay for an order?', tags: ['pay','payment','mpesa','card'], content: 'At checkout, choose M-Pesa STK Push (recommended), M-Pesa Paybill, or debit/credit card via IntaSend. M-Pesa STK Push sends a payment prompt directly to your phone — just enter your PIN.' },
      { id: 27, category: 'Payments', title: 'My M-Pesa payment failed — what do I do?', tags: ['failed','mpesa','error','retry'], content: 'First check that your M-Pesa PIN is correct and you have sufficient balance. If the STK push didn\'t arrive, tap "Retry Payment". If still failing, contact support via WhatsApp.' },
      { id: 28, category: 'Payments', title: 'Is my payment information safe?', tags: ['safe','secure','data','privacy'], content: 'Yes. SOKONI uses 256-bit TLS encryption. We never store your M-Pesa PIN. Payments are processed by IntaSend (licensed by CBK). Your card data is tokenised by PCI-DSS certified systems.' },
      { id: 29, category: 'Payments', title: 'How long does payment take to reflect?', tags: ['time','reflect','confirm','pending'], content: 'M-Pesa payments reflect within 30 seconds. Card payments may take 1–2 minutes. If your payment hasn\'t reflected after 5 minutes, tap "Check Payment Status" in your order.' },
      { id: 30, category: 'Payments', title: 'How do I set up M-Pesa for my seller account?', tags: ['mpesa','setup','seller','receive'], content: 'In Seller Dashboard → Payments → Add M-Pesa Number. Enter your number and verify via OTP. You can also add a Till Number or Paybill for business payments.' },
      { id: 31, category: 'Payments', title: 'What is escrow and how does it protect me?', tags: ['escrow','protect','hold','release'], content: 'Escrow holds the buyer\'s payment securely until the order is confirmed as delivered. Once delivery is confirmed, funds are released to the seller. This protects both parties.' },
      { id: 32, category: 'Payments', title: 'How do I get a refund?', tags: ['refund','money back','reverse','chargeback'], content: 'Open a dispute (Profile → Orders → Report a Problem → Refund Request). If approved, refunds are processed to your original payment method within 1–3 business days.' },

      /* ── Delivery ── */
      { id: 33, category: 'Delivery', title: 'How does SOKONI delivery work?', tags: ['delivery','rider','boda','courier'], content: 'SOKONI connects you with verified boda boda and courier drivers. After placing an order, a nearby driver is assigned automatically. You can track them live on the map.' },
      { id: 34, category: 'Delivery', title: 'How much does delivery cost?', tags: ['cost','fee','delivery charge','price'], content: 'Delivery fees depend on distance and delivery type. Standard delivery within Nairobi starts at KES 80. Express delivery (under 2 hours) starts at KES 150. Fees shown at checkout.' },
      { id: 35, category: 'Delivery', title: 'How long does delivery take?', tags: ['time','duration','how long','ETA'], content: 'Standard delivery: same-day within county (2–6 hours). Express: within 2 hours (Nairobi Metro). Inter-county: 1–3 days. Track live in Profile → Orders.' },
      { id: 36, category: 'Delivery', title: 'What if my delivery is late?', tags: ['late','delayed','not arrived','overdue'], content: 'If your order is overdue, tap "Contact Rider" to message the driver directly. If no response, open a dispute and we\'ll escalate. Compensation applies to SOKONI Express delays.' },
      { id: 37, category: 'Delivery', title: 'Can I pick up my order?', tags: ['pickup','collect','self pickup','in-person'], content: 'If the seller offers pickup, you\'ll see "Pickup Available" on the listing. Select "Pickup" at checkout and you\'ll receive the seller\'s pickup address and available hours.' },
      { id: 38, category: 'Delivery', title: 'My package arrived damaged — what do I do?', tags: ['damaged','broken','crushed','package'], content: 'Take photos immediately and report via Profile → Orders → [Order] → "Report Damage". Upload photos. Do not discard packaging. We\'ll investigate and process a replacement or refund.' },

      /* ── Safety ── */
      { id: 39, category: 'Safety', title: 'How do I report a scam or fake listing?', tags: ['scam','fake','fraud','report'], content: 'Tap the three-dot menu on any listing → "Report Listing". Select the reason (e.g. "Fake listing" or "Scam"). Our moderation team reviews all reports within 24 hours.' },
      { id: 40, category: 'Safety', title: 'How do I stay safe when meeting sellers in person?', tags: ['safe','meet','in person','safety tips'], content: 'Always meet in a public place (e.g. supermarket, petrol station). Bring a friend for high-value transactions. Inspect the item before paying. Never pay cash to unknown sellers in advance.' },
      { id: 41, category: 'Safety', title: 'What are common scams to watch out for?', tags: ['scam','fraud','tricks','warning'], content: 'Common scams: sellers asking you to pay outside SOKONI, "too good to be true" prices, fake SOKONI agent accounts, asking for OTP codes. SOKONI will never ask for your PIN or OTP.' },
      { id: 42, category: 'Safety', title: 'How do I report a user?', tags: ['report','user','block','flag'], content: 'Go to the user\'s profile → tap the three-dot menu → "Report User". Choose a reason and add details. You can also block the user to stop all contact.' },
      { id: 43, category: 'Safety', title: 'How does SOKONI verify sellers and professionals?', tags: ['verify','trust','badge','verified'], content: 'Verified users submit their National ID, phone number, and (for professionals) their license. Our team manually reviews documents. Verified badges are shown on all their listings.' },

      /* ── Disputes ── */
      { id: 44, category: 'Disputes', title: 'How do I open a dispute?', tags: ['dispute','problem','complaint','open'], content: 'Go to Profile → Orders → [Order] → "Report a Problem". Describe the issue and upload evidence (photos, screenshots). A dispute case is opened immediately.' },
      { id: 45, category: 'Disputes', title: 'How long does dispute resolution take?', tags: ['time','resolve','how long','dispute'], content: 'Standard disputes are resolved within 48–72 hours. Complex cases (fraud, large amounts) may take up to 7 days. You\'re notified at every step via SMS and app notification.' },
      { id: 46, category: 'Disputes', title: 'What happens after I open a dispute?', tags: ['process','steps','what happens','dispute'], content: 'Both buyer and seller are notified. Each party submits their evidence. A SOKONI mediator reviews everything and makes a decision. Both parties can message during the process.' },
      { id: 47, category: 'Disputes', title: 'Can I appeal a dispute decision?', tags: ['appeal','disagree','escalate','review'], content: 'Yes. If you disagree with the decision, tap "Appeal" within 72 hours. Your case goes to a senior mediator. SOKONI\'s final decisions are binding under our Terms of Service.' },
      { id: 48, category: 'Disputes', title: 'What evidence should I submit for a dispute?', tags: ['evidence','proof','photos','screenshots'], content: 'Submit: photos of the item received, screenshots of the listing and conversation, M-Pesa confirmation, delivery receipt, and any other relevant proof. More evidence = faster resolution.' },
      { id: 49, category: 'Disputes', title: 'How do I become a SOKONI delivery driver?', tags: ['driver','boda','delivery','register'], content: 'Visit mysokoni.co.ke/onboarding-driver.html to apply. You\'ll need your vehicle details, driving license, National ID and M-Pesa number. Approval takes 24 hours after document review.' },
      { id: 50, category: 'Disputes', title: 'How do I register as a professional on SOKONI?', tags: ['professional','doctor','lawyer','consultant','register'], content: 'Go to onboarding-professional.html. Select your professional type, submit your credentials and license number. Our team verifies with the relevant board within 48 hours.' }
    ],

    search: function (query) {
      if (!query || !query.trim()) return [];
      var q = query.toLowerCase().trim();
      var tokens = q.split(/\s+/);
      return this.articles.filter(function (a) {
        var haystack = (a.title + ' ' + a.content + ' ' + a.tags.join(' ')).toLowerCase();
        return tokens.every(function (token) { return haystack.indexOf(token) !== -1; });
      });
    }
  };

})(window);
