/* ================================================================
   SOKONI — Chat Engine  v1.0
   Transaction-gated business messaging: send, receive, upload,
   voice recording, typing indicators, read receipts.
   Exposes: window.SokoniChat
================================================================ */
(function (g) {
'use strict';

/* ─────────────────────────────────────────────────────────────
   TRANSACTION CONTEXT REGISTRY
──────────────────────────────────────────────────────────────*/
var CONTEXTS = {
  order: {
    label: 'Order', icon: 'shopping_bag',
    actions: [
      { id:'track_order',  label:'Track Order',   icon:'location_on',    url:'order-detail.html' },
      { id:'cancel_order', label:'Cancel Order',  icon:'cancel',         confirm:true },
      { id:'return_item',  label:'Return Item',   icon:'assignment_return' },
      { id:'view_invoice', label:'Invoice',       icon:'receipt_long',   url:'invoice.html' },
    ],
    fields: ['status','amount','orderDate','deliveryDate'],
  },
  service_booking: {
    label: 'Service Booking', icon: 'home_repair_service',
    actions: [
      { id:'share_location',   label:'Share Location',   icon:'share_location' },
      { id:'start_service',    label:'Start Service',    icon:'play_circle' },
      { id:'complete_service', label:'Complete Service', icon:'check_circle' },
      { id:'view_invoice',     label:'Invoice',          icon:'receipt_long', url:'invoice.html' },
    ],
    fields: ['status','amount','scheduledDate','provider'],
  },
  food_order: {
    label: 'Food Order', icon: 'restaurant',
    actions: [
      { id:'track_order',  label:'Track Order',  icon:'location_on' },
      { id:'cancel_order', label:'Cancel Order', icon:'cancel', confirm:true },
    ],
    fields: ['status','amount','estimatedTime'],
  },
  pharmacy_order: {
    label: 'Pharmacy Order', icon: 'medication',
    actions: [
      { id:'track_order',  label:'Track Order',  icon:'location_on' },
      { id:'view_invoice', label:'Invoice',      icon:'receipt_long' },
    ],
    fields: ['status','amount','orderDate'],
  },
  property_inquiry: {
    label: 'Property Inquiry', icon: 'home',
    actions: [
      { id:'schedule_viewing',  label:'Schedule Viewing',  icon:'event' },
      { id:'request_documents', label:'Request Documents', icon:'folder_open' },
      { id:'make_offer',        label:'Make Offer',        icon:'paid' },
    ],
    fields: ['propertyTitle','price','location'],
  },
  vehicle_inquiry: {
    label: 'Vehicle Inquiry', icon: 'directions_car',
    actions: [
      { id:'book_inspection', label:'Book Inspection', icon:'search' },
      { id:'negotiate_price', label:'Negotiate Price', icon:'handshake' },
    ],
    fields: ['vehicleTitle','price','year','mileage'],
  },
  job_application: {
    label: 'Job Application', icon: 'work',
    actions: [
      { id:'schedule_interview', label:'Schedule Interview', icon:'event' },
      { id:'upload_cv',          label:'Upload CV',          icon:'description' },
      { id:'hire_candidate',     label:'Hire Candidate',     icon:'how_to_reg' },
    ],
    fields: ['jobTitle','company','appliedDate','status'],
  },
  freelancer_engagement: {
    label: 'Freelancer Project', icon: 'laptop',
    actions: [
      { id:'start_project',    label:'Start Project',    icon:'play_circle' },
      { id:'submit_milestone', label:'Submit Milestone', icon:'flag' },
      { id:'release_payment',  label:'Release Payment',  icon:'paid' },
    ],
    fields: ['projectTitle','budget','deadline','status'],
  },
  event_booking: {
    label: 'Event Booking', icon: 'confirmation_number',
    actions: [
      { id:'view_ticket',  label:'View Ticket', icon:'confirmation_number' },
      { id:'cancel_order', label:'Cancel',      icon:'cancel', confirm:true },
    ],
    fields: ['eventName','date','venue','amount'],
  },
  hotel_reservation: {
    label: 'Hotel Reservation', icon: 'hotel',
    actions: [
      { id:'view_booking',  label:'View Booking', icon:'book_online' },
      { id:'cancel_order',  label:'Cancel',       icon:'cancel', confirm:true },
    ],
    fields: ['hotelName','checkIn','checkOut','guests','amount'],
  },
  financial_request: {
    label: 'Financial Service', icon: 'account_balance',
    actions: [
      { id:'upload_documents', label:'Upload Documents', icon:'folder_open' },
      { id:'view_status',      label:'View Status',      icon:'info' },
    ],
    fields: ['serviceType','amount','status'],
  },
  healthcare_appointment: {
    label: 'Healthcare Appointment', icon: 'local_hospital',
    actions: [
      { id:'upload_prescription', label:'Upload Prescription', icon:'description' },
      { id:'book_followup',       label:'Book Follow-up',      icon:'event' },
    ],
    fields: ['doctorName','appointmentDate','specialty','status'],
  },
  legal_consultation: {
    label: 'Legal Consultation', icon: 'balance',
    actions: [
      { id:'upload_contract',   label:'Upload Contract',   icon:'gavel' },
      { id:'book_consultation', label:'Book Consultation', icon:'event' },
    ],
    fields: ['lawyerName','consultationDate','matter','status'],
  },
  insurance_request: {
    label: 'Insurance Request', icon: 'shield',
    actions: [
      { id:'upload_documents', label:'Upload Documents', icon:'folder_open' },
      { id:'view_policy',      label:'View Policy',      icon:'policy' },
    ],
    fields: ['policyType','amount','startDate','status'],
  },
  logistics_request: {
    label: 'Delivery Request', icon: 'local_shipping',
    actions: [
      { id:'track_order',  label:'Track Delivery', icon:'location_on' },
      { id:'view_invoice', label:'Invoice',        icon:'receipt_long' },
    ],
    fields: ['pickupAddress','dropoffAddress','status','amount'],
  },
  support_ticket: {
    label: 'Support Ticket', icon: 'headset_mic',
    actions: [
      { id:'escalate',     label:'Escalate',     icon:'arrow_upward' },
      { id:'close_ticket', label:'Close Ticket', icon:'check_circle' },
    ],
    fields: ['ticketId','subject','priority','status'],
  },
  rfq: {
    label: 'Request for Quotation', icon: 'request_quote',
    actions: [
      { id:'submit_quote', label:'Submit Quote', icon:'paid' },
      { id:'accept_quote', label:'Accept Quote', icon:'check_circle' },
      { id:'reject_quote', label:'Reject Quote', icon:'cancel' },
    ],
    fields: ['itemDescription','quantity','deadline','status'],
  },
};

/* ─────────────────────────────────────────────────────────────
   CATEGORY REGISTRY  (2026-09-30, messages inbox repair)
   A category is a NAMED SET OF CONTEXTS KEYS — never a type of its
   own. The inbox renders chips from this list, so a category can
   only exist here if the engine already knows the types behind it.

     kind 'all'    — every conversation
     kind 'unread' — unreadCount > 0 (server-written on the projection)
     kind 'action' — every context whose actions carry `action`
                     (Invoices = contexts that offer `view_invoice`;
                      there is NO invoice conversation type)
     kind 'other'  — a transactionType the registry does not know
                     (legacy rows); rendered only when one exists
     types [...]   — explicit CONTEXTS keys

   Every CONTEXTS key is covered by exactly one `types` category —
   scripts/test-messages-premium.js holds that line.
──────────────────────────────────────────────────────────────*/
var CATEGORIES = [
  { id:'all',        label:'All',         icon:'forum',            kind:'all' },
  { id:'unread',     label:'Unread',      icon:'mark_chat_unread', kind:'unread' },
  { id:'orders',     label:'Orders',      icon:'shopping_bag',     types:['order','food_order','pharmacy_order'] },
  { id:'deliveries', label:'Deliveries',  icon:'local_shipping',   types:['logistics_request'] },
  { id:'invoices',   label:'Invoices',    icon:'receipt_long',     kind:'action', action:'view_invoice' },
  { id:'bookings',   label:'Bookings',    icon:'event_available',  types:['service_booking','hotel_reservation','event_booking'] },
  { id:'healthcare', label:'Healthcare',  icon:'local_hospital',   types:['healthcare_appointment'] },
  { id:'legal',      label:'Legal',       icon:'balance',          types:['legal_consultation'] },
  { id:'property',   label:'Property',    icon:'home',             types:['property_inquiry'] },
  { id:'vehicles',   label:'Vehicles',    icon:'directions_car',   types:['vehicle_inquiry'] },
  { id:'work',       label:'Jobs & Work', icon:'work',             types:['job_application','freelancer_engagement'] },
  { id:'finance',    label:'Finance',     icon:'account_balance',  types:['financial_request','insurance_request'] },
  { id:'quotes',     label:'Quotes',      icon:'request_quote',    types:['rfq'] },
  { id:'support',    label:'Support',     icon:'headset_mic',      types:['support_ticket'] },
  { id:'other',      label:'Other',       icon:'chat',             kind:'other' },
];

/* Resolve action-derived categories ONCE from the registry above, and refuse a
   category that names a type the engine does not have — a chip with no backing
   type is exactly the defect this registry exists to prevent. */
(function _resolveCategories() {
  CATEGORIES.forEach(function (cat) {
    if (cat.kind === 'action') {
      cat.types = Object.keys(CONTEXTS).filter(function (k) {
        return (CONTEXTS[k].actions || []).some(function (a) { return a.id === cat.action; });
      });
      cat.derived = true;
    }
    (cat.types || []).forEach(function (t) {
      if (!CONTEXTS[t]) throw new Error('[chat] category "' + cat.id + '" names unknown type "' + t + '"');
    });
  });
})();

function getCategory(id) {
  for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i];
  return null;
}

/* Does conversation `c` (a userConversations projection row) belong to `cat`?
   Only fields the server writes are consulted: transactionType, unreadCount. */
function categoryMatches(cat, c) {
  if (typeof cat === 'string') cat = getCategory(cat);
  if (!cat || !c) return false;
  var type = c.transactionType;
  if (cat.kind === 'all')    return true;
  if (cat.kind === 'unread') return (typeof c.unreadCount === 'number' ? c.unreadCount : 0) > 0;
  if (cat.kind === 'other')  return !CONTEXTS[type];
  return (cat.types || []).indexOf(type) !== -1;
}

/* Per-category counts from REAL rows. `visible` hides `other` until a row needs it. */
function categorySummary(convs) {
  convs = convs || [];
  return CATEGORIES.map(function (cat) {
    var count = 0, unread = 0;
    convs.forEach(function (c) {
      if (!categoryMatches(cat, c)) return;
      count++;
      unread += (typeof c.unreadCount === 'number' && c.unreadCount > 0) ? c.unreadCount : 0;
    });
    return { id: cat.id, label: cat.label, icon: cat.icon, kind: cat.kind || 'types',
             derived: !!cat.derived, types: (cat.types || []).slice(), count: count, unread: unread,
             visible: cat.kind === 'other' ? count > 0 : true };
  });
}

/* ─────────────────────────────────────────────────────────────
   FIREBASE ACCESSORS
──────────────────────────────────────────────────────────────*/
function _db()  { return firebase.firestore(); }
function _auth(){ return firebase.auth();      }
function _stor(){ return firebase.storage();   }
function _fns() { return firebase.functions(); }
function _uid() { var u = _auth().currentUser; return u ? u.uid : null; }
function _FS()  { return firebase.firestore.FieldValue; }

/* ─────────────────────────────────────────────────────────────
   UTILITIES
──────────────────────────────────────────────────────────────*/
function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _timeStr(ts) {
  if (!ts) return '';
  var d   = ts.toDate ? ts.toDate() : new Date(ts);
  var now = new Date();
  var ms  = now - d;
  if (ms < 60000)    return 'Just now';
  if (ms < 3600000)  return Math.floor(ms/60000) + 'm ago';
  if (ms < 86400000) return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if (ms < 604800000)return d.toLocaleDateString([],{weekday:'short'});
  return d.toLocaleDateString([],{day:'numeric',month:'short'});
}

function _msgTime(ts) {
  if (!ts) return '';
  var d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}

function _fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1048576)    return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1048576).toFixed(1) + ' MB';
}

/* ─────────────────────────────────────────────────────────────
   IMAGE COMPRESSION
──────────────────────────────────────────────────────────────*/
function _compressImage(file, maxW, quality) {
  maxW    = maxW    || 1280;
  quality = quality || 0.82;
  return new Promise(function(resolve) {
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function() {
      var w = img.width, h = img.height;
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(function(blob) {
        URL.revokeObjectURL(url);
        resolve(blob && blob.size < file.size ? blob : file);
      }, 'image/jpeg', quality);
    };
    img.onerror = function() { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

function _makeThumbnail(file) {
  return _compressImage(file, 200, 0.7);
}

/* ─────────────────────────────────────────────────────────────
   VOICE RECORDER
──────────────────────────────────────────────────────────────*/
var _recorder  = null;
var _recChunks = [];
var _recStart  = 0;

function startRecording() {
  return new Promise(function(resolve, reject) {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
      _recChunks = [];
      var mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/mp4';
      _recorder = new MediaRecorder(stream, { mimeType: mime });
      _recorder.ondataavailable = function(e) { if (e.data.size > 0) _recChunks.push(e.data); };
      _recorder.start(100);
      _recStart = Date.now();
      resolve();
    }).catch(reject);
  });
}

function stopRecording() {
  return new Promise(function(resolve) {
    if (!_recorder) { resolve({ blob: null, duration: 0 }); return; }
    var duration = Math.round((Date.now() - _recStart) / 1000);
    _recorder.onstop = function() {
      var blob = new Blob(_recChunks, { type: _recorder.mimeType || 'audio/webm' });
      _recChunks = [];
      if (_recorder.stream) _recorder.stream.getTracks().forEach(function(t) { t.stop(); });
      _recorder = null;
      resolve({ blob: blob, duration: duration });
    };
    _recorder.stop();
  });
}

function cancelRecording() {
  if (!_recorder) return;
  _recChunks = [];
  if (_recorder.stream) _recorder.stream.getTracks().forEach(function(t) { t.stop(); });
  _recorder = null;
}

/* ─────────────────────────────────────────────────────────────
   FILE UPLOAD TO CLOUD STORAGE
──────────────────────────────────────────────────────────────*/
function _uploadFile(conversationId, messageId, file, mediaType, onProgress) {
  var uid  = _uid();
  var name = file.name || ('attachment.' + (file.type || 'bin').split('/').pop());
  var ext  = name.split('.').pop().toLowerCase();
  var path = 'chatAttachments/' + uid + '/' + conversationId + '/' + messageId + '.' + ext;

  return Promise.resolve().then(function() {
    if (mediaType === 'image') return _compressImage(file);
    return file;
  }).then(function(uploadFile) {
    var thumbPromise = mediaType === 'image'
      ? _makeThumbnail(file).then(function(thumb) {
          var tpath = 'chatAttachments/' + uid + '/' + conversationId + '/' + messageId + '_thumb.jpg';
          return _stor().ref().child(tpath).put(thumb).then(function() { return tpath; });
        })
      : Promise.resolve(null);

    return Promise.all([
      new Promise(function(resolve, reject) {
        var task = _stor().ref().child(path).put(uploadFile, {
          contentType:  file.type || 'application/octet-stream',
          customMetadata: { conversationId: conversationId, messageId: messageId },
        });
        task.on('state_changed',
          function(snap) { if (onProgress) onProgress(Math.round(snap.bytesTransferred / snap.totalBytes * 100)); },
          reject,
          function() { resolve(path); }
        );
      }),
      thumbPromise,
    ]);
  }).then(function(results) {
    return {
      storageRef:   results[0],
      thumbnailRef: results[1] || null,
      fileName:     name,
      fileSize:     file.size,
    };
  });
}

/* ─────────────────────────────────────────────────────────────
   GET DOWNLOAD URL
──────────────────────────────────────────────────────────────*/
function getAttachmentUrl(storageRef) {
  if (!storageRef) return Promise.resolve(null);
  return _stor().ref().child(storageRef).getDownloadURL().catch(function() { return null; });
}

/* ─────────────────────────────────────────────────────────────
   SEND MESSAGE — routed through sendMessage CF (MSG-1 fix)
   The CF hard-codes senderId = req.auth.uid and server-resolves
   senderName, preventing client-side spoofing of either field.
   File messages: upload to Storage first, then call CF with the
   storageRef — the CF validates the path belongs to the caller.
──────────────────────────────────────────────────────────────*/
function sendMessage(conversationId, payload) {
  var uid = _uid();
  if (!uid) return Promise.reject(new Error('Not authenticated'));
  if (!conversationId) return Promise.reject(new Error('conversationId required'));

  var type = payload.type || 'text';
  var callSendMessage = function(d) { return _cfMsg('sendMessage', d); };

  /* Text and location go directly to the CF */
  if (type === 'text' || type === 'location') {
    var callData = {
      conversationId:  conversationId,
      type:            type,
      replyToId:       payload.replyToId       || null,
      replyToText:     payload.replyToText      ? String(payload.replyToText).slice(0, 100) : null,
      replyToSenderId: payload.replyToSenderId  || null,
    };
    if (type === 'text') {
      var text = (payload.text || '').trim().slice(0, 4000);
      if (!text) return Promise.reject(new Error('Message cannot be empty'));
      callData.text = text;
    } else {
      callData.lat     = payload.lat;
      callData.lng     = payload.lng;
      callData.address = payload.address || null;
    }
    return callSendMessage(callData).then(function(r) { return r.data; });
  }

  /* File-based: upload to chatAttachments first, then call CF */
  if (!payload.file) return Promise.reject(new Error('File is required for ' + type));
  var placeholderId = _db().collection('_tmp').doc().id; // random ID for upload path only
  return _uploadFile(conversationId, placeholderId, payload.file, type, payload.onProgress)
    .then(function(uploaded) {
      return callSendMessage({
        conversationId:  conversationId,
        type:            type,
        storageRef:      uploaded.storageRef,
        thumbnailRef:    uploaded.thumbnailRef || null,
        fileName:        uploaded.fileName,
        fileSize:        uploaded.fileSize,
        mimeType:        payload.file.type || '',
        duration:        type === 'voice' ? (payload.duration || 0) : undefined,
        replyToId:       payload.replyToId       || null,
        replyToText:     payload.replyToText      ? String(payload.replyToText).slice(0, 100) : null,
        replyToSenderId: payload.replyToSenderId  || null,
      });
    }).then(function(r) { return r.data; });
}

/* ─────────────────────────────────────────────────────────────
   SOFT DELETE MESSAGE
──────────────────────────────────────────────────────────────*/
function deleteMessage(conversationId, messageId) {
  var uid = _uid();
  var ref = _db().collection('conversations').doc(conversationId).collection('messages').doc(messageId);
  return ref.get().then(function(snap) {
    if (!snap.exists) throw new Error('Message not found');
    if (snap.data().senderId !== uid) throw new Error('Cannot delete another user\'s message');
    return ref.update({ deleted: true, text: null, storageRef: null, deletedAt: _FS().serverTimestamp() });
  });
}

/* ─────────────────────────────────────────────────────────────
   LISTENERS
──────────────────────────────────────────────────────────────*/
function onConversationsChanged(callback) {
  var uid = _uid();
  if (!uid) return function() {};
  return _db().collection('userConversations').doc(uid).collection('items')
    .orderBy('lastMessageAt', 'desc')
    .limit(50)
    .onSnapshot(
      function(snap) { callback(null, snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); })); },
      function(err)  { callback(err); }
    );
}

function onMessagesChanged(conversationId, callback) {
  return _db().collection('conversations').doc(conversationId).collection('messages')
    .orderBy('timestamp', 'desc')
    .limit(20)
    .onSnapshot(
      function(snap) {
        var msgs = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); }).reverse();
        callback(null, msgs);
      },
      function(err) { callback(err); }
    );
}

function onTypingChanged(conversationId, callback) {
  var uid = _uid();
  return _db().collection('typingIndicators').doc(conversationId).collection('users')
    .onSnapshot(function(snap) {
      var now = Date.now();
      var typing = snap.docs.filter(function(d) {
        var data = d.data();
        var ts   = data.updatedAt && data.updatedAt.toMillis ? data.updatedAt.toMillis() : 0;
        return d.id !== uid && data.isTyping && (now - ts < 5000);
      }).map(function(d) { return d.id; });
      callback(typing);
    }, function() {});
}

/* ─────────────────────────────────────────────────────────────
   LOAD OLDER MESSAGES (PAGINATION)
──────────────────────────────────────────────────────────────*/
function loadOlderMessages(conversationId, beforeTimestamp) {
  return _db().collection('conversations').doc(conversationId).collection('messages')
    .orderBy('timestamp', 'desc')
    .startAfter(beforeTimestamp)
    .limit(20)
    .get()
    .then(function(snap) {
      return snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); }).reverse();
    });
}

/* ─────────────────────────────────────────────────────────────
   TYPING INDICATOR
──────────────────────────────────────────────────────────────*/
var _typingTimers = {};

function setTyping(conversationId, isTyping) {
  var uid = _uid();
  if (!uid) return;
  try {
    _db().collection('typingIndicators').doc(conversationId)
      .collection('users').doc(uid)
      .set({ isTyping: isTyping, updatedAt: _FS().serverTimestamp() });
  } catch(e) {}
}

function handleTyping(conversationId) {
  setTyping(conversationId, true);
  clearTimeout(_typingTimers[conversationId]);
  _typingTimers[conversationId] = setTimeout(function() { setTyping(conversationId, false); }, 3000);
}

/* ─────────────────────────────────────────────────────────────
   CALLABLE CF WRAPPERS
   All ops route through messagesDispatch to reduce Cloud Run services.
──────────────────────────────────────────────────────────────*/
function _cfMsg(op, data) {
  return _fns().httpsCallable('messagesDispatch')({ op: op, ...(data || {}) });
}

/* Participants are DERIVED BY THE SERVER from the transaction (functions/messages.js
   _partiesOf). The third argument is kept for call-compatibility but is never sent:
   a client-supplied list is inert server-side and must not travel in the request. */
function createConversation(transactionType, transactionId, _participantUidsIgnored, metadata) {
  return _cfMsg('createConversation', {
    transactionType: transactionType,
    transactionId:   transactionId,
    metadata:        metadata || {},
  }).then(function(r) { return r.data; });
}

function markRead(conversationId) {
  return _cfMsg('markRead', { conversationId: conversationId })
    .then(function(r) { return r.data; })
    .catch(function(e) { console.warn('[chat] markRead', e.message); });
}

function reportConversation(conversationId, reason, details) {
  return _cfMsg('reportConversation', {
    conversationId: conversationId,
    reason:         reason,
    details:        details || null,
  }).then(function(r) { return r.data; });
}

function getConversation(conversationId) {
  var uid = _uid();
  if (!uid) return Promise.resolve(null);
  return _db().collection('conversations').doc(conversationId).get().then(function(snap) {
    if (!snap.exists) return null;
    var data = snap.data();
    if (!data.participants.includes(uid)) return null;
    return Object.assign({ id: snap.id }, data);
  });
}

function editMessage(conversationId, messageId, newText) {
  return _cfMsg('editMessage', {
    conversationId: conversationId,
    messageId:      messageId,
    newText:        newText,
  }).then(function(r) { return r.data; });
}

function getConversationContext(conversationId) {
  return _cfMsg('getConversationContext', { conversationId: conversationId })
    .then(function(r) { return r.data; });
}

function searchConversations(query, transactionType, cursor) {
  return _cfMsg('searchConversations', {
    query:           query           || '',
    transactionType: transactionType || null,
    cursor:          cursor          || null,
  }).then(function(r) { return r.data; });
}

function updateConversationStatus(conversationId, newStatus, systemMessage) {
  return _cfMsg('updateConversationStatus', {
    conversationId: conversationId,
    newStatus:      newStatus,
    systemMessage:  systemMessage || null,
  }).then(function(r) { return r.data; });
}

/* ─────────────────────────────────────────────────────────────
   FORWARD MESSAGE
   Re-sends message content into the same conversation.
   For media types, sends a text label pointing to the original.
──────────────────────────────────────────────────────────────*/
function forwardMessage(conversationId, msg) {
  var payload;
  if (!msg || msg.deleted) return Promise.reject(new Error('Cannot forward a deleted message'));
  if (msg.type === 'text' && msg.text) {
    payload = { type: 'text', text: '↩ Forwarded: ' + msg.text.slice(0, 3990) };
  } else if (msg.type === 'image') {
    payload = { type: 'text', text: '↩ Forwarded an image' + (msg.fileName ? ': ' + msg.fileName : '') };
  } else if (msg.type === 'pdf' || msg.type === 'document') {
    payload = { type: 'text', text: '↩ Forwarded a document' + (msg.fileName ? ': ' + msg.fileName : '') };
  } else if (msg.type === 'voice') {
    payload = { type: 'text', text: '↩ Forwarded a voice note (' + _fmtDurSafe(msg.duration) + ')' };
  } else {
    return Promise.reject(new Error('Cannot forward this message type'));
  }
  return sendMessage(conversationId, payload);
}

function _fmtDurSafe(secs) {
  var s = Math.floor(secs || 0);
  var m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

/* ─────────────────────────────────────────────────────────────
   SEARCH MESSAGES (client-side — no extra Firestore reads)
   Filters an array of message objects by query text.
──────────────────────────────────────────────────────────────*/
function searchMessages(msgs, query) {
  if (!query || !query.trim()) return msgs || [];
  var q = query.toLowerCase().trim();
  return (msgs || []).filter(function(m) {
    if (m.deleted || m.type === 'system') return false;
    if (m.type === 'text' && m.text) return m.text.toLowerCase().indexOf(q) !== -1;
    if (m.fileName) return m.fileName.toLowerCase().indexOf(q) !== -1;
    return false;
  });
}

/* ─────────────────────────────────────────────────────────────
   PUBLIC API
──────────────────────────────────────────────────────────────*/
var SokoniChat = {
  /* Conversation */
  createConversation:      createConversation,
  getConversation:         getConversation,
  onConversationsChanged:  onConversationsChanged,
  searchConversations:     searchConversations,
  updateConversationStatus:updateConversationStatus,

  /* Messages */
  sendMessage:      sendMessage,
  editMessage:      editMessage,
  deleteMessage:    deleteMessage,
  onMessagesChanged:onMessagesChanged,
  loadOlderMessages:loadOlderMessages,

  /* Attachments */
  getAttachmentUrl: getAttachmentUrl,

  /* Read receipts */
  markRead: markRead,

  /* Typing */
  handleTyping:    handleTyping,
  setTyping:       setTyping,
  onTypingChanged: onTypingChanged,

  /* Voice */
  startRecording:  startRecording,
  stopRecording:   stopRecording,
  cancelRecording: cancelRecording,

  /* Reports */
  reportConversation: reportConversation,

  /* Forward / search */
  forwardMessage:  forwardMessage,
  searchMessages:  searchMessages,

  /* Context */
  getConversationContext: getConversationContext,
  CONTEXTS:               CONTEXTS,
  getContext: function(type) { return CONTEXTS[type] || { label:'Conversation', icon:'chat', actions:[], fields:[] }; },

  /* Categories (inbox chips) — derived from CONTEXTS, see CATEGORY REGISTRY */
  CATEGORIES:       CATEGORIES,
  getCategory:      getCategory,
  categoryMatches:  categoryMatches,
  categorySummary:  categorySummary,

  /* Utilities */
  timeStr:  _timeStr,
  msgTime:  _msgTime,
  fmtSize:  _fmtSize,
  esc:      _esc,
};

g.SokoniChat = SokoniChat;
if (typeof module !== 'undefined') module.exports = SokoniChat;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
