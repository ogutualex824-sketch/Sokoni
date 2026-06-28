/* ============================================================
   SOKONI Foundation — Cloud Functions
   Charitable Giving Platform Backend
   16 Cloud Functions covering:
     donations (STK push + wallet), recurring, receipts,
     applications, campaigns, stats, admin, search
============================================================ */

'use strict';

const { onCall, onSchedule, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule: _sched } = require('firebase-functions/v2/scheduler');
const admin   = require('firebase-admin');
const crypto  = require('crypto');
const https   = require('https');
const { defineSecret } = require('firebase-functions/params');

const db  = admin.firestore;
const fdb = () => admin.firestore();

const INTASEND_PRIVATE_KEY = defineSecret('INTASEND_PRIVATE_KEY');
const SENDGRID_API_KEY     = defineSecret('SENDGRID_API_KEY');

/* ── helpers ─────────────────────────────────────────────── */
const _now   = () => admin.firestore().FieldValue.serverTimestamp();
const _incr  = (n) => admin.firestore().FieldValue.increment(n);
const _esc   = (s) => String(s || '').replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c]));
const _san   = (s, max = 500) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);
const _phone = (p) => String(p || '').replace(/\D/g, '').replace(/^0/, '254').replace(/^254254/, '254');
const _isAdmin = (auth) => auth && (auth.token?.admin === true || auth.token?.superAdmin === true || auth.token?.role === 'admin' || auth.token?.role === 'superAdmin');
const _uid = (auth) => auth && auth.uid;

/* Receipt number: FND-YYYYMMDD-XXXX */
const _receiptNo = () => {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const rand = Math.random().toString(36).slice(2,6).toUpperCase();
  return `FND-${ymd}-${rand}`;
};

/* Rate limiter backed by Firestore */
async function _rateLimit(key, max, windowMs) {
  const ref  = fdb().collection('_rateLimits').doc(key);
  const snap = await ref.get();
  const now  = Date.now();
  if (snap.exists) {
    const { count, windowStart } = snap.data();
    if (now - windowStart < windowMs) {
      if (count >= max) return false;
      await ref.update({ count: _incr(1) });
    } else {
      await ref.set({ count: 1, windowStart: now });
    }
  } else {
    await ref.set({ count: 1, windowStart: now });
  }
  return true;
}

/* IntaSend STK push */
async function _stkPush(privKey, { phone, amount, ref, comment }) {
  const isSandbox = process.env.INTASEND_SANDBOX === 'true';
  const host      = isSandbox ? 'sandbox.intasend.com' : 'payment.intasend.com';
  const payload   = JSON.stringify({
    phone_number: _phone(phone),
    amount:       String(Math.round(amount)),
    currency:     'KES',
    api_ref:      ref,
    comment:      comment || 'SOKONI Foundation Donation',
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path:     '/api/v1/payment/mpesa-stk-push/',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Token ${privKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (_) { reject(new Error('Invalid IntaSend response')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* IntaSend STK push status check */
async function _stkStatus(privKey, checkoutId) {
  const isSandbox = process.env.INTASEND_SANDBOX === 'true';
  const host      = isSandbox ? 'sandbox.intasend.com' : 'payment.intasend.com';
  return new Promise((resolve, reject) => {
    https.get({
      hostname: host,
      path:     `/api/v1/payment/mpesa-stk-push/${checkoutId}/`,
      headers: { 'Authorization': `Token ${privKey}` },
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (_) { reject(new Error('Status check parse error')); }
      });
    }).on('error', reject);
  });
}

/* ── send email via SendGrid ─────────────────────────────── */
async function _sendEmail(sgKey, { to, subject, html }) {
  const payload = JSON.stringify({
    personalizations: [{ to: [{ email: to }] }],
    from: { email: 'foundation@mysokoni.co.ke', name: 'SOKONI Foundation' },
    subject,
    content: [{ type: 'text/html', value: html }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path:     '/v3/mail/send',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${sgKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => { resolve(res.statusCode); });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* Receipt HTML generator */
function _buildReceiptHTML(don) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>SOKONI Foundation Receipt</title>
<style>
body{font-family:'Segoe UI',system-ui,sans-serif;background:#050505;color:white;margin:0;padding:40px 20px;}
.receipt{max-width:480px;margin:0 auto;background:#0a0a0a;border:1px solid rgba(245,158,11,0.2);border-radius:20px;padding:40px;position:relative;}
.logo{text-align:center;margin-bottom:24px;}
.logo-name{font-size:18px;font-weight:900;color:#f59e0b;}
.badge{display:inline-block;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);color:#10b981;font-size:11px;font-weight:800;padding:4px 12px;border-radius:6px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:20px;}
h2{font-size:22px;font-weight:900;margin:0 0 28px;color:white;text-align:center;}
.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:13px;}
.row .label{color:rgba(255,255,255,0.4);font-weight:600;}
.row .val{color:white;font-weight:700;}
.amount-row{padding:16px 0;font-size:18px;}
.amount-row .val{color:#f59e0b;font-size:22px;}
.seal{text-align:center;margin-top:28px;font-size:11px;color:rgba(255,255,255,0.3);line-height:1.8;}
.qr-area{text-align:center;margin:20px 0;}
.qr-code{font-size:11px;color:rgba(255,255,255,0.3);font-family:monospace;word-break:break-all;}
@media print{body{background:white;color:#111;}
.receipt{border-color:#ddd;background:white;}
.row .label{color:#666;}.row .val{color:#111;}
.seal{color:#999;}.qr-code{color:#999;}}
</style></head>
<body>
<div class="receipt">
  <div class="logo"><span class="logo-name">SOKONI FOUNDATION</span></div>
  <div style="text-align:center"><span class="badge">✅ Official Donation Receipt</span></div>
  <h2>Thank You for Your Contribution</h2>
  <div class="row"><span class="label">Receipt No.</span><span class="val">${_esc(don.receiptNo)}</span></div>
  <div class="row"><span class="label">Transaction ID</span><span class="val">${_esc(don.checkoutId || don.id)}</span></div>
  <div class="row"><span class="label">Date</span><span class="val">${_esc(don.dateStr)}</span></div>
  <div class="row"><span class="label">Donor</span><span class="val">${_esc(don.donorName || 'Anonymous')}</span></div>
  <div class="row amount-row"><span class="label">Amount Donated</span><span class="val">KES ${Number(don.amount).toLocaleString()}</span></div>
  <div class="row"><span class="label">Destination</span><span class="val">${_esc(don.destination || 'General Foundation')}</span></div>
  <div class="row"><span class="label">Payment Method</span><span class="val">${_esc(don.method || 'M-Pesa')}</span></div>
  <div class="row"><span class="label">Status</span><span class="val" style="color:#10b981;">Completed ✓</span></div>
  <div class="qr-area">
    <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:6px;">Verification Code</div>
    <div class="qr-code">${_esc(don.verifyCode)}</div>
    <div style="font-size:10px;color:rgba(255,255,255,0.2);margin-top:4px;">Verify at mysokoni.co.ke/foundation</div>
  </div>
  <div class="seal">
    SOKONI Foundation · Registration Pending (KE-NGO-2026)<br>
    100% of contributions directed to programs — zero admin deductions<br>
    info@mysokoni.co.ke · 0705 726 803
  </div>
</div>
</body>
</html>`;
}

/* ══════════════════════════════════════════════════════════
   1. foundationGetStats — public live impact stats
══════════════════════════════════════════════════════════ */
exports.foundationGetStats = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async () => {
    const snap = await fdb().collection('foundationStats').doc('current').get();
    if (snap.exists) return { ok: true, stats: snap.data() };

    /* Seed defaults if not yet initialised */
    const defaults = {
      totalDonations: 0, totalDisbursed: 0, totalDonors: 0,
      youthTrained: 1240, grantsIssued: 340, countiesReached: 18,
      vendorsDigitised: 680, jobsCreated: 820, beneficiaries: 2100,
      treesPlanted: 0, mealsProvided: 0, schoolFeesPaid: 0, medicalSupport: 0,
      activeCampaigns: 6, completedCampaigns: 2, femalePct: 52,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await fdb().collection('foundationStats').doc('current').set(defaults).catch(() => {});
    return { ok: true, stats: defaults };
  }
);

/* ══════════════════════════════════════════════════════════
   2. foundationDonate — M-Pesa STK push donation
══════════════════════════════════════════════════════════ */
exports.foundationDonate = onCall(
  { timeoutSeconds: 40, enforceAppCheck: true, secrets: [INTASEND_PRIVATE_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to donate.');

    const uid = request.auth.uid;
    const { amount, phone, destination, frequency, displayName, anonymous } = request.data || {};

    /* Validate */
    const amt = Math.round(Number(amount) || 0);
    if (amt < 50)  throw new HttpsError('invalid-argument', 'Minimum donation is KES 50.');
    if (amt > 500000) throw new HttpsError('invalid-argument', 'Maximum single donation is KES 500,000.');
    const rawPhone = _phone(phone || '');
    if (!/^2547\d{8}$/.test(rawPhone)) throw new HttpsError('invalid-argument', 'Enter a valid Safaricom number.');

    /* Rate limit: 5 donations per uid per hour */
    const ok = await _rateLimit(`fn_don_${uid}`, 5, 3600000);
    if (!ok) throw new HttpsError('resource-exhausted', 'Too many donations. Please wait before trying again.');

    const donId  = `fn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
    const recNo  = _receiptNo();
    const privKey = INTASEND_PRIVATE_KEY.value();

    /* Push STK */
    const stkRes = await _stkPush(privKey, {
      phone:   rawPhone,
      amount:  amt,
      ref:     donId,
      comment: `SOKONI Foundation — ${_san(destination, 30) || 'General'}`,
    });

    if (stkRes.status !== 200 && stkRes.status !== 201) {
      throw new HttpsError('internal', stkRes.data?.detail || 'STK Push failed. Please try again.');
    }

    const checkoutId = stkRes.data?.checkout_id || stkRes.data?.id || '';
    if (!checkoutId) throw new HttpsError('internal', 'No payment reference from gateway.');

    /* Write pending donation */
    const verifyCode = crypto.randomBytes(12).toString('hex').toUpperCase();
    await fdb().collection('foundationDonations').doc(donId).set({
      id: donId, uid, receiptNo: recNo, checkoutId, verifyCode,
      amount: amt, phone: rawPhone,
      destination: _san(destination, 60) || 'General Foundation',
      frequency:   _san(frequency, 20) || 'one-time',
      donorName:   anonymous ? 'Anonymous' : _san(displayName, 80) || 'Anonymous',
      anonymous:   !!anonymous,
      method:      'M-Pesa',
      status:      'pending',
      createdAt:   _now(), updatedAt: _now(),
    });

    return { ok: true, donationId: donId, checkoutId };
  }
);

/* ══════════════════════════════════════════════════════════
   3. foundationCheckPayment — poll STK push status
══════════════════════════════════════════════════════════ */
exports.foundationCheckPayment = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true, secrets: [INTASEND_PRIVATE_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;
    const { donationId } = request.data || {};
    if (!donationId) throw new HttpsError('invalid-argument', 'donationId required.');

    const docRef = fdb().collection('foundationDonations').doc(donationId);
    const snap   = await docRef.get();
    if (!snap.exists || snap.data().uid !== uid) throw new HttpsError('not-found', 'Donation not found.');

    const don = snap.data();
    if (don.status === 'completed') return { ok: true, status: 'completed', receiptNo: don.receiptNo };
    if (don.status === 'failed')    return { ok: true, status: 'failed' };

    /* Check with IntaSend */
    const privKey = INTASEND_PRIVATE_KEY.value();
    const stkRes  = await _stkStatus(privKey, don.checkoutId).catch(() => null);
    const state   = stkRes?.data?.state || stkRes?.data?.status || '';

    if (['COMPLETE', 'COMPLETED', 'SUCCESS'].includes(String(state).toUpperCase())) {
      const dateStr = new Date().toLocaleDateString('en-KE', { year:'numeric', month:'long', day:'numeric' });
      await docRef.update({ status: 'completed', completedAt: _now(), dateStr, updatedAt: _now() });

      /* Update platform stats */
      const statsRef = fdb().collection('foundationStats').doc('current');
      const batch = fdb().batch();
      batch.set(statsRef, {
        totalDonations: _incr(don.amount),
        totalDonors:    _incr(1),
        updatedAt:      _now(),
      }, { merge: true });

      /* If recurring, create recurring record */
      if (don.frequency && don.frequency !== 'one-time') {
        const nextMap = { daily: 1, weekly: 7, monthly: 30 };
        const days    = nextMap[don.frequency] || 30;
        const nextDate = new Date(Date.now() + days * 86400000);
        const recRef = fdb().collection('foundationRecurring').doc(`${uid}_${don.destination}`);
        batch.set(recRef, {
          uid, donationId, amount: don.amount, phone: don.phone,
          destination: don.destination, frequency: don.frequency,
          status: 'active', nextPaymentDate: nextDate,
          donorName: don.donorName, method: 'M-Pesa',
          createdAt: _now(), updatedAt: _now(),
        }, { merge: true });
      }
      await batch.commit();

      return { ok: true, status: 'completed', receiptNo: don.receiptNo, verifyCode: don.verifyCode };
    }

    if (['FAILED', 'CANCELLED', 'CANCELED', 'TIMEOUT'].includes(String(state).toUpperCase())) {
      await docRef.update({ status: 'failed', updatedAt: _now() });
      return { ok: true, status: 'failed' };
    }

    return { ok: true, status: 'pending' };
  }
);

/* ══════════════════════════════════════════════════════════
   4. foundationDonateWallet — donate from SOKONI wallet
══════════════════════════════════════════════════════════ */
exports.foundationDonateWallet = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;
    const { amount, destination, displayName, anonymous, frequency } = request.data || {};

    const amt = Math.round(Number(amount) || 0);
    if (amt < 50) throw new HttpsError('invalid-argument', 'Minimum donation is KES 50.');

    const ok = await _rateLimit(`fn_wallet_${uid}`, 10, 3600000);
    if (!ok) throw new HttpsError('resource-exhausted', 'Too many requests.');

    const walletRef = fdb().collection('wallets').doc(uid);
    const donId     = `fnw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
    const recNo     = _receiptNo();
    const verifyCode = crypto.randomBytes(12).toString('hex').toUpperCase();
    const dateStr   = new Date().toLocaleDateString('en-KE', { year:'numeric', month:'long', day:'numeric' });

    await fdb().runTransaction(async (txn) => {
      const wallet = await txn.get(walletRef);
      const balance = Number(wallet.exists ? wallet.data().balance : 0);
      if (balance < amt) throw new HttpsError('failed-precondition', `Insufficient wallet balance. Available: KES ${balance.toLocaleString()}.`);

      txn.update(walletRef, { balance: _incr(-amt), updatedAt: _now() });

      txn.set(fdb().collection('walletTransactions').doc(donId), {
        uid, amount: -amt, type: 'foundation_donation', ref: donId,
        description: `Foundation donation — ${destination || 'General'}`,
        createdAt: _now(),
      });

      txn.set(fdb().collection('foundationDonations').doc(donId), {
        id: donId, uid, receiptNo: recNo, checkoutId: donId, verifyCode,
        amount: amt, destination: _san(destination, 60) || 'General Foundation',
        frequency: _san(frequency, 20) || 'one-time',
        donorName: anonymous ? 'Anonymous' : _san(displayName, 80) || 'Anonymous',
        anonymous: !!anonymous, method: 'Wallet', status: 'completed', dateStr,
        createdAt: _now(), updatedAt: _now(), completedAt: _now(),
      });

      txn.set(fdb().collection('foundationStats').doc('current'), {
        totalDonations: _incr(amt), totalDonors: _incr(1), updatedAt: _now(),
      }, { merge: true });
    });

    return { ok: true, donationId: donId, receiptNo: recNo, verifyCode };
  }
);

/* ══════════════════════════════════════════════════════════
   5. foundationGetMyDonations — donor history
══════════════════════════════════════════════════════════ */
exports.foundationGetMyDonations = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid   = request.auth.uid;
    const limit = Math.min(Number(request.data?.limit) || 20, 50);
    const snap  = await fdb().collection('foundationDonations')
      .where('uid', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const donations = snap.docs.map(d => {
      const { uid: _u, phone, ...rest } = d.data();
      return { id: d.id, ...rest, phone: phone ? `${phone.slice(0,7)}****` : '' };
    });
    return { ok: true, donations };
  }
);

/* ══════════════════════════════════════════════════════════
   6. foundationGetMyApplications — application history
══════════════════════════════════════════════════════════ */
exports.foundationGetMyApplications = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid  = request.auth.uid;
    const snap = await fdb().collection('foundationApplications')
      .where('uid', '==', uid).orderBy('createdAt', 'desc').limit(20).get();
    return { ok: true, applications: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  }
);

/* ══════════════════════════════════════════════════════════
   7. foundationSubmitApplication — save program application
══════════════════════════════════════════════════════════ */
exports.foundationSubmitApplication = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    /* Rate limit by IP/uid: 3 applications per 24 hours */
    const uid = _uid(request.auth) || 'anon';
    const ok  = await _rateLimit(`fn_app_${uid}`, 3, 86400000);
    if (!ok) throw new HttpsError('resource-exhausted', 'Maximum 3 applications per day. Please try tomorrow.');

    const { name, phone, county, story, age, program, source, email } = request.data || {};
    if (!name || !phone || !county || !story || !program) {
      throw new HttpsError('invalid-argument', 'Name, phone, county, story and program are required.');
    }
    if (_san(story, 5000).length < 30) throw new HttpsError('invalid-argument', 'Please write at least 30 characters about your story.');

    const docRef = fdb().collection('foundationApplications').doc();
    await docRef.set({
      id:       docRef.id,
      uid:      uid !== 'anon' ? uid : null,
      name:     _san(name, 100),
      phone:    _san(phone, 20),
      county:   _san(county, 60),
      story:    _san(story, 5000),
      age:      Number(age) || null,
      program:  _san(program, 50),
      source:   _san(source, 80) || '',
      email:    _san(email, 200) || '',
      status:   'pending',
      reviewed: false,
      createdAt: _now(), updatedAt: _now(),
    });

    return { ok: true, applicationId: docRef.id };
  }
);

/* ══════════════════════════════════════════════════════════
   8. foundationManageRecurring — pause/resume/cancel/update
══════════════════════════════════════════════════════════ */
exports.foundationManageRecurring = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;
    const { recurringId, action, newAmount } = request.data || {};
    if (!recurringId || !action) throw new HttpsError('invalid-argument', 'recurringId and action required.');

    const ref  = fdb().collection('foundationRecurring').doc(recurringId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().uid !== uid) throw new HttpsError('not-found', 'Recurring donation not found.');

    const allowed = ['pause', 'resume', 'cancel', 'update'];
    if (!allowed.includes(action)) throw new HttpsError('invalid-argument', 'Invalid action.');

    const update = { updatedAt: _now() };
    if (action === 'pause')  update.status = 'paused';
    if (action === 'resume') update.status = 'active';
    if (action === 'cancel') update.status = 'cancelled';
    if (action === 'update') {
      const amt = Math.round(Number(newAmount) || 0);
      if (amt < 50) throw new HttpsError('invalid-argument', 'Minimum KES 50.');
      update.amount = amt;
    }

    await ref.update(update);
    return { ok: true };
  }
);

/* ══════════════════════════════════════════════════════════
   9. foundationGetMyRecurring — list recurring donations
══════════════════════════════════════════════════════════ */
exports.foundationGetMyRecurring = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid  = request.auth.uid;
    const snap = await fdb().collection('foundationRecurring')
      .where('uid', '==', uid).where('status', '!=', 'cancelled').get();
    return { ok: true, recurring: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
  }
);

/* ══════════════════════════════════════════════════════════
   10. foundationGenerateReceipt — fetch receipt data for a donation
══════════════════════════════════════════════════════════ */
exports.foundationGenerateReceipt = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid  = request.auth.uid;
    const { donationId } = request.data || {};
    if (!donationId) throw new HttpsError('invalid-argument', 'donationId required.');

    const snap = await fdb().collection('foundationDonations').doc(donationId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Donation not found.');
    const don = snap.data();
    if (don.uid !== uid && !_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Access denied.');
    if (don.status !== 'completed') throw new HttpsError('failed-precondition', 'Donation not yet completed.');

    const receipt = _buildReceiptHTML(don);
    return { ok: true, html: receipt, receiptNo: don.receiptNo, verifyCode: don.verifyCode };
  }
);

/* ══════════════════════════════════════════════════════════
   11. foundationEmailReceipt — email receipt to donor
══════════════════════════════════════════════════════════ */
exports.foundationEmailReceipt = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true, secrets: [SENDGRID_API_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = request.auth.uid;
    const { donationId, email } = request.data || {};
    if (!donationId || !email) throw new HttpsError('invalid-argument', 'donationId and email required.');
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Invalid email address.');

    const snap = await fdb().collection('foundationDonations').doc(donationId).get();
    if (!snap.exists || snap.data().uid !== uid) throw new HttpsError('not-found', 'Donation not found.');
    const don = snap.data();
    if (don.status !== 'completed') throw new HttpsError('failed-precondition', 'Donation not completed.');

    const html = _buildReceiptHTML(don);
    await _sendEmail(SENDGRID_API_KEY.value(), {
      to:      email,
      subject: `Your SOKONI Foundation Receipt — ${don.receiptNo}`,
      html,
    });

    return { ok: true };
  }
);

/* ══════════════════════════════════════════════════════════
   12. foundationVerifyReceipt — public QR verification
══════════════════════════════════════════════════════════ */
exports.foundationVerifyReceipt = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    const { verifyCode } = request.data || {};
    if (!verifyCode) throw new HttpsError('invalid-argument', 'verifyCode required.');

    const snap = await fdb().collection('foundationDonations')
      .where('verifyCode', '==', _san(verifyCode, 40))
      .where('status', '==', 'completed')
      .limit(1).get();

    if (snap.empty) return { ok: true, valid: false };
    const don = snap.docs[0].data();
    return {
      ok: true, valid: true,
      receiptNo:   don.receiptNo,
      amount:      don.amount,
      destination: don.destination,
      dateStr:     don.dateStr || '',
      donorName:   don.anonymous ? 'Anonymous Donor' : don.donorName,
    };
  }
);

/* ══════════════════════════════════════════════════════════
   13. foundationGetCampaigns — public campaign listing
══════════════════════════════════════════════════════════ */
exports.foundationGetCampaigns = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    const { category, limit: rawLimit, status: statusFilter } = request.data || {};
    const lim = Math.min(Number(rawLimit) || 12, 50);

    let q = fdb().collection('foundationCampaigns')
      .where('status', '==', statusFilter || 'active')
      .orderBy('createdAt', 'desc')
      .limit(lim);
    if (category && category !== 'all') q = q.where('category', '==', _san(category, 40));

    const snap = await q.get();
    return {
      ok: true,
      campaigns: snap.docs.map(d => {
        const c = d.data();
        return {
          id: d.id, title: c.title, description: c.description, coverImage: c.coverImage,
          goal: c.goal, raised: c.raised || 0, beneficiaries: c.beneficiaries || 0,
          category: c.category, location: c.location, daysLeft: c.daysLeft,
          verified: c.verified || false, urgent: c.urgent || false,
          programKey: c.programKey || '', status: c.status,
          createdAt: c.createdAt, completedAt: c.completedAt,
        };
      }),
    };
  }
);

/* ══════════════════════════════════════════════════════════
   14. foundationGetTransparency — admin transparency data
══════════════════════════════════════════════════════════ */
exports.foundationGetTransparency = onCall(
  { timeoutSeconds: 20, enforceAppCheck: true },
  async (request) => {
    const [statsSnap, recentSnap] = await Promise.all([
      fdb().collection('foundationStats').doc('current').get(),
      fdb().collection('foundationDonations')
        .where('status', '==', 'completed')
        .orderBy('createdAt', 'desc')
        .limit(10).get(),
    ]);

    const stats = statsSnap.exists ? statsSnap.data() : {};
    const recent = recentSnap.docs.map(d => {
      const don = d.data();
      return {
        amount: don.amount, destination: don.destination,
        donorName: don.anonymous ? 'Anonymous' : don.donorName,
        dateStr: don.dateStr || '', method: don.method,
      };
    });

    return { ok: true, stats, recentDonations: recent };
  }
);

/* ══════════════════════════════════════════════════════════
   15. foundationAdminDashboard — admin analytics
══════════════════════════════════════════════════════════ */
exports.foundationAdminDashboard = onCall(
  { timeoutSeconds: 30, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');

    const [statsSnap, donSnap, appSnap, recurSnap] = await Promise.all([
      fdb().collection('foundationStats').doc('current').get(),
      fdb().collection('foundationDonations').orderBy('createdAt','desc').limit(50).get(),
      fdb().collection('foundationApplications').where('status','==','pending').orderBy('createdAt','desc').limit(30).get(),
      fdb().collection('foundationRecurring').where('status','==','active').limit(50).get(),
    ]);

    /* Aggregate daily donations for the chart (group by dateStr) */
    const byDay = {};
    donSnap.docs.forEach(d => {
      const don = d.data();
      if (don.status === 'completed') {
        const key = don.dateStr || 'Unknown';
        byDay[key] = (byDay[key] || 0) + don.amount;
      }
    });

    return {
      ok: true,
      stats:        statsSnap.exists ? statsSnap.data() : {},
      donations:    donSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      applications: appSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      recurring:    recurSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      dailyChart:   Object.entries(byDay).map(([date, amount]) => ({ date, amount })).slice(-14),
    };
  }
);

/* ══════════════════════════════════════════════════════════
   16. foundationAdminUpdateApp — review applications
══════════════════════════════════════════════════════════ */
exports.foundationAdminUpdateApp = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const { appId, status, notes } = request.data || {};
    if (!appId || !['approved','rejected','waitlisted','interview'].includes(status)) {
      throw new HttpsError('invalid-argument', 'appId and valid status required.');
    }
    await fdb().collection('foundationApplications').doc(appId).update({
      status, reviewed: true,
      adminNotes: _san(notes, 1000) || '',
      reviewedAt: _now(), reviewedBy: request.auth.uid,
      updatedAt: _now(),
    });
    return { ok: true };
  }
);

/* ══════════════════════════════════════════════════════════
   17. foundationAdminUpdateStats — manual stat overrides
══════════════════════════════════════════════════════════ */
exports.foundationAdminUpdateStats = onCall(
  { timeoutSeconds: 15, enforceAppCheck: true },
  async (request) => {
    if (!_isAdmin(request.auth)) throw new HttpsError('permission-denied', 'Admin only.');
    const allowed = ['youthTrained','grantsIssued','countiesReached','vendorsDigitised',
                     'jobsCreated','beneficiaries','treesPlanted','mealsProvided',
                     'schoolFeesPaid','medicalSupport','totalDisbursed','femalePct'];
    const updates = { updatedAt: _now() };
    for (const key of allowed) {
      if (request.data?.[key] !== undefined) {
        updates[key] = Number(request.data[key]) || 0;
      }
    }
    await fdb().collection('foundationStats').doc('current').set(updates, { merge: true });
    return { ok: true };
  }
);

/* ══════════════════════════════════════════════════════════
   18. foundationScheduledRecurring — daily recurring processor
   Runs at 08:00 EAT (05:00 UTC) every day
══════════════════════════════════════════════════════════ */
exports.foundationScheduledRecurring = _sched(
  { schedule: '0 5 * * *', timeZone: 'Africa/Nairobi', secrets: [INTASEND_PRIVATE_KEY], timeoutSeconds: 540 },
  async () => {
    const now  = new Date();
    const snap = await fdb().collection('foundationRecurring')
      .where('status', '==', 'active')
      .where('nextPaymentDate', '<=', now)
      .limit(50).get();

    if (snap.empty) { console.log('[Foundation] No recurring donations due.'); return; }

    const privKey = INTASEND_PRIVATE_KEY.value();

    for (const doc of snap.docs) {
      const rec = doc.data();
      try {
        const donId = `fnr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
        const recNo = _receiptNo();
        const verifyCode = crypto.randomBytes(12).toString('hex').toUpperCase();
        const dateStr = now.toLocaleDateString('en-KE', { year:'numeric', month:'long', day:'numeric' });

        const stkRes = await _stkPush(privKey, {
          phone:   rec.phone,
          amount:  rec.amount,
          ref:     donId,
          comment: `SOKONI Foundation Recurring — ${rec.destination || 'General'}`,
        });

        if (stkRes.status === 200 || stkRes.status === 201) {
          const checkoutId = stkRes.data?.checkout_id || stkRes.data?.id || '';

          await fdb().collection('foundationDonations').doc(donId).set({
            id: donId, uid: rec.uid, receiptNo: recNo, checkoutId, verifyCode,
            amount: rec.amount, phone: rec.phone,
            destination: rec.destination, frequency: rec.frequency,
            donorName: rec.donorName, method: 'M-Pesa (Recurring)',
            status: 'pending', dateStr,
            createdAt: _now(), updatedAt: _now(),
          });

          /* Advance next payment date */
          const nextMap = { daily: 1, weekly: 7, monthly: 30 };
          const days    = nextMap[rec.frequency] || 30;
          const nextDate = new Date(now.getTime() + days * 86400000);
          await doc.ref.update({ nextPaymentDate: nextDate, lastTriggered: _now(), updatedAt: _now() });
        }
      } catch (e) {
        console.error(`[Foundation Recurring] Failed for ${doc.id}:`, e.message);
      }
    }
  }
);
