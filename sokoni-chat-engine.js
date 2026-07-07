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
   SEND MESSAGE (direct Firestore write)
──────────────────────────────────────────────────────────────*/
function sendMessage(conversationId, payload) {
  var uid  = _uid();
  var user = _auth().currentUser;
  if (!uid) return Promise.reject(new Error('Not authenticated'));
  if (!conversationId) return Promise.reject(new Error('conversationId required'));

  var db = _db();
  return db.collection('conversations').doc(conversationId).get().then(function(snap) {
    if (!snap.exists) throw new Error('Conversation not found');
    var conv = snap.data();
    if (!conv.participants.includes(uid)) throw new Error('Not a participant');
    if (conv.status === 'read_only')  throw new Error('This conversation is now read-only');
    if (conv.status === 'suspended')  throw new Error('This conversation has been suspended');
    if (conv.status === 'closed')     throw new Error('This conversation is closed');

    var msgRef    = db.collection('conversations').doc(conversationId).collection('messages').doc();
    var messageId = msgRef.id;

    var msgData = {
      senderId:   uid,
      senderName: (user && (user.displayName || user.email)) || 'User',
      timestamp:  _FS().serverTimestamp(),
      type:       payload.type || 'text',
      status:     'sent',
      deleted:    false,
      edited:     false,
      flagged:    false,
    };

    if (payload.replyToId) {
      msgData.replyToId       = payload.replyToId;
      msgData.replyToText     = (payload.replyToText  || '').slice(0, 100);
      msgData.replyToSenderId = payload.replyToSenderId || null;
    }

    if (payload.type === 'text') {
      var text = (payload.text || '').trim().slice(0, 4000);
      if (!text) throw new Error('Message cannot be empty');
      msgData.text = text;
      return msgRef.set(msgData).then(function() { return { messageId: messageId }; });
    }

    /* File-based message: upload first, then write doc */
    if (!payload.file) throw new Error('File is required for ' + payload.type);
    return _uploadFile(conversationId, messageId, payload.file, payload.type, payload.onProgress)
      .then(function(uploaded) {
        msgData.storageRef   = uploaded.storageRef;
        msgData.thumbnailRef = uploaded.thumbnailRef;
        msgData.fileName     = uploaded.fileName;
        msgData.fileSize     = uploaded.fileSize;
        msgData.mimeType     = payload.file.type || '';
        msgData.mediaType    = payload.type;
        if (payload.type === 'voice') msgData.duration = payload.duration || 0;
        return msgRef.set(msgData);
      }).then(function() { return { messageId: messageId }; });
  });
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
──────────────────────────────────────────────────────────────*/
function createConversation(transactionType, transactionId, participantUids, metadata) {
  return _fns().httpsCallable('createConversation')({
    transactionType: transactionType,
    transactionId:   transactionId,
    participantUids: participantUids,
    metadata:        metadata || {},
  }).then(function(r) { return r.data; });
}

function markRead(conversationId) {
  return _fns().httpsCallable('markRead')({ conversationId: conversationId })
    .then(function(r) { return r.data; })
    .catch(function(e) { console.warn('[chat] markRead', e.message); });
}

function reportConversation(conversationId, reason, details) {
  return _fns().httpsCallable('reportConversation')({
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
  return _fns().httpsCallable('editMessage')({
    conversationId: conversationId,
    messageId:      messageId,
    newText:        newText,
  }).then(function(r) { return r.data; });
}

function getConversationContext(conversationId) {
  return _fns().httpsCallable('getConversationContext')({ conversationId: conversationId })
    .then(function(r) { return r.data; });
}

function searchConversations(query, transactionType, cursor) {
  return _fns().httpsCallable('searchConversations')({
    query:           query           || '',
    transactionType: transactionType || null,
    cursor:          cursor          || null,
  }).then(function(r) { return r.data; });
}

function updateConversationStatus(conversationId, newStatus, systemMessage) {
  return _fns().httpsCallable('updateConversationStatus')({
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

  /* Utilities */
  timeStr:  _timeStr,
  msgTime:  _msgTime,
  fmtSize:  _fmtSize,
  esc:      _esc,
};

g.SokoniChat = SokoniChat;
if (typeof module !== 'undefined') module.exports = SokoniChat;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
