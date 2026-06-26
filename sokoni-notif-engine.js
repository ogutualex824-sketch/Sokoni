/**
 * SOKONI NOTIFICATION ENGINE v1.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Core notification engine for the SOKONI Enterprise Notification Platform.
 *
 * Responsibilities:
 *  - Priority-based notification routing (Critical → Silent)
 *  - Per-category, per-user preference management
 *  - Do-Not-Disturb and Quiet Hours enforcement
 *  - Intelligent grouping (reduces clutter: "3 New Orders" not "Order, Order, Order")
 *  - Offline queue (localStorage → Firestore sync)
 *  - Real-time Firestore listener with cross-tab BroadcastChannel sync
 *  - Notification fatigue detection
 *  - Deduplication (prevents replay attacks / double delivery)
 *  - History with search and filter
 *
 * Firestore collections:
 *  notifications/{notifId}         — notification documents (existing schema + extensions)
 *  userNotifPrefs/{userId}         — per-user preferences document
 *
 * Exposed on: window.SokoniNotifEngine
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function(global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────────────── */

  var PRIORITY = Object.freeze({
    CRITICAL: 'critical',  /* 5 — Always delivered, bypasses DND, shows interstitial alert */
    HIGH:     'high',      /* 4 — Delivered immediately, animates bell */
    NORMAL:   'normal',    /* 3 — Standard delivery */
    LOW:      'low',       /* 2 — Batched, shown in center only */
    SILENT:   'silent'     /* 1 — Badge only, no sound, no animation */
  });

  var PRIORITY_RANK = { critical: 5, high: 4, normal: 3, low: 2, silent: 1 };

  var CATEGORIES = Object.freeze({
    all:          { label: 'All',           icon: '🔔', defaultOn: true  },
    unread:       { label: 'Unread',        icon: '🔵', defaultOn: true  },
    important:    { label: 'Important',     icon: '⭐', defaultOn: true  },
    orders:       { label: 'Orders',        icon: '📦', defaultOn: true  },
    payments:     { label: 'Payments',      icon: '💳', defaultOn: true  },
    messages:     { label: 'Messages',      icon: '💬', defaultOn: true  },
    marketplace:  { label: 'Marketplace',   icon: '🏪', defaultOn: true  },
    deliveries:   { label: 'Deliveries',    icon: '🚚', defaultOn: true  },
    bookings:     { label: 'Bookings',      icon: '📅', defaultOn: true  },
    inventory:    { label: 'Inventory',     icon: '📊', defaultOn: true  },
    pos:          { label: 'POS',           icon: '🖥️',  defaultOn: true  },
    employees:    { label: 'Employees',     icon: '👥', defaultOn: true  },
    security:     { label: 'Security',      icon: '🔒', defaultOn: true  },
    system:       { label: 'System',        icon: '⚙️',  defaultOn: true  },
    updates:      { label: 'Updates',       icon: '🔄', defaultOn: true  },
    promotions:   { label: 'Promotions',    icon: '🎁', defaultOn: false },
    ai:           { label: 'AI Assistant',  icon: '🤖', defaultOn: true  },
    business:     { label: 'Business',      icon: '💼', defaultOn: true  },
    verification: { label: 'Verification',  icon: '✅', defaultOn: true  },
    finance:      { label: 'Finance',       icon: '💰', defaultOn: true  },
    support:      { label: 'Support',       icon: '🛟', defaultOn: true  }
  });

  var PANEL_CATEGORIES = [
    'all','unread','important','orders','payments','messages',
    'marketplace','deliveries','bookings','inventory','pos',
    'employees','security','system','updates','promotions',
    'ai','business','verification','finance','support'
  ];

  var PREF_CATEGORIES = [
    'orders','payments','messages','marketplace','deliveries',
    'bookings','inventory','pos','promotions','ai','security','system',
    'updates','business','verification','finance','support','employees'
  ];

  var ACTIONS = Object.freeze({
    VIEW:      { id: 'view',      label: 'View',          icon: '👁️'  },
    APPROVE:   { id: 'approve',   label: 'Approve',       icon: '✅'  },
    REJECT:    { id: 'reject',    label: 'Reject',        icon: '❌'  },
    ACCEPT:    { id: 'accept',    label: 'Accept',        icon: '👍'  },
    REPLY:     { id: 'reply',     label: 'Reply',         icon: '↩️'  },
    PAY:       { id: 'pay',       label: 'Pay',           icon: '💳'  },
    TRACK:     { id: 'track',     label: 'Track',         icon: '📍'  },
    ARCHIVE:   { id: 'archive',   label: 'Archive',       icon: '📁'  },
    DELETE:    { id: 'delete',    label: 'Delete',        icon: '🗑️'  },
    MARK_READ: { id: 'mark_read', label: 'Mark as Read',  icon: '✓'   },
    PIN:       { id: 'pin',       label: 'Pin',           icon: '📌'  },
    MUTE:      { id: 'mute',      label: 'Mute Similar',  icon: '🔕'  }
  });

  /* ─────────────────────────────────────────────────────────────────────────
     DEFAULT PREFERENCES
  ───────────────────────────────────────────────────────────────────────── */

  function _defaultPrefs() {
    var cats = {};
    PREF_CATEGORIES.forEach(function(c) {
      cats[c] = CATEGORIES[c] ? CATEGORIES[c].defaultOn : true;
    });
    return {
      globalEnabled: true,
      pausedUntil: null,
      sound: true,
      vibrate: true,
      dnd: { enabled: false, startTime: '22:00', endTime: '07:00', allowCritical: true },
      categories: cats,
      fatigue: { windowMs: 3600000, maxCount: 30 }  /* max 30 per hour before suppressing */
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PREFERENCE MANAGER
  ───────────────────────────────────────────────────────────────────────── */

  var NotifPrefs = {
    _prefs: null,
    _userId: null,
    _db: null,

    load: function(userId, db) {
      this._userId = userId;
      this._db = db;
      /* Load from localStorage (instant) */
      try {
        var stored = localStorage.getItem('sk_notif_prefs_' + (userId || 'guest'));
        this._prefs = stored ? Object.assign(_defaultPrefs(), JSON.parse(stored)) : _defaultPrefs();
      } catch(e) {
        this._prefs = _defaultPrefs();
      }
      /* Sync from Firestore in background */
      if (userId && db) this._syncFromFirestore();
      return this._prefs;
    },

    get: function() {
      return this._prefs || _defaultPrefs();
    },

    save: function(partial) {
      this._prefs = Object.assign(this._prefs || _defaultPrefs(), partial);
      try {
        localStorage.setItem('sk_notif_prefs_' + (this._userId || 'guest'), JSON.stringify(this._prefs));
      } catch(e) {}
      if (this._userId && this._db) this._saveToFirestore();
    },

    setCategoryEnabled: function(cat, enabled) {
      var prefs = this.get();
      prefs.categories[cat] = !!enabled;
      this.save({ categories: prefs.categories });
    },

    setGlobalEnabled: function(enabled) {
      this.save({ globalEnabled: !!enabled });
    },

    pauseFor: function(ms) {
      this.save({ pausedUntil: ms > 0 ? Date.now() + ms : null });
    },

    setDND: function(dndConfig) {
      var prefs = this.get();
      this.save({ dnd: Object.assign(prefs.dnd, dndConfig) });
    },

    isAllowed: function(category, priority) {
      var prefs = this.get();
      if (!prefs.globalEnabled) {
        /* Only CRITICAL can bypass global disable */
        return priority === PRIORITY.CRITICAL;
      }
      /* Pause check */
      if (prefs.pausedUntil && Date.now() < prefs.pausedUntil) {
        return priority === PRIORITY.CRITICAL;
      }
      /* DND / Quiet Hours check */
      if (prefs.dnd.enabled && this._inQuietHours(prefs.dnd)) {
        if (prefs.dnd.allowCritical && priority === PRIORITY.CRITICAL) return true;
        if (priority !== PRIORITY.CRITICAL && priority !== PRIORITY.HIGH) return false;
        return priority === PRIORITY.CRITICAL;
      }
      /* Category check */
      if (category && prefs.categories[category] === false) {
        return priority === PRIORITY.CRITICAL;
      }
      return true;
    },

    _inQuietHours: function(dnd) {
      var now = new Date();
      var hhmm = function(ts) {
        var p = ts.split(':');
        return parseInt(p[0]) * 60 + parseInt(p[1]);
      };
      var nowMin   = now.getHours() * 60 + now.getMinutes();
      var startMin = hhmm(dnd.startTime || '22:00');
      var endMin   = hhmm(dnd.endTime   || '07:00');
      if (startMin < endMin) {
        return nowMin >= startMin && nowMin < endMin;
      }
      /* Overnight range (e.g. 22:00 → 07:00) */
      return nowMin >= startMin || nowMin < endMin;
    },

    _syncFromFirestore: function() {
      var self = this;
      if (!self._db || !self._userId) return;
      try {
        if (self._db._modular) {
          var m = self._db._modular, fs = self._db._fs;
          m.getDoc(m.doc(fs, 'userNotifPrefs', self._userId)).then(function(snap) {
            if (snap.exists()) {
              var data = snap.data();
              self._prefs = Object.assign(_defaultPrefs(), data);
              try { localStorage.setItem('sk_notif_prefs_' + self._userId, JSON.stringify(self._prefs)); } catch(e) {}
              if (global.SokoniNotifEngine) global.SokoniNotifEngine._emit('prefs_changed', self._prefs);
            }
          }).catch(function() {});
        } else if (self._db.collection) {
          self._db.collection('userNotifPrefs').doc(self._userId)
            .get().then(function(snap) {
              if (snap.exists) {
                var data = snap.data();
                self._prefs = Object.assign(_defaultPrefs(), data);
                try { localStorage.setItem('sk_notif_prefs_' + self._userId, JSON.stringify(self._prefs)); } catch(e) {}
                if (global.SokoniNotifEngine) global.SokoniNotifEngine._emit('prefs_changed', self._prefs);
              }
            }).catch(function() {});
        }
      } catch(e) {}
    },

    _saveToFirestore: function() {
      var self = this;
      if (!self._db || !self._userId) return;
      try {
        if (self._db._modular) {
          var m = self._db._modular, fs = self._db._fs;
          m.setDoc(m.doc(fs, 'userNotifPrefs', self._userId), self._prefs, { merge: true }).catch(function() {});
        } else if (self._db.collection) {
          self._db.collection('userNotifPrefs').doc(self._userId)
            .set(self._prefs, { merge: true }).catch(function() {});
        }
      } catch(e) {}
    }
  };

  /* ─────────────────────────────────────────────────────────────────────────
     OFFLINE QUEUE
     Stores notifications locally when offline; syncs when back online.
  ───────────────────────────────────────────────────────────────────────── */

  var NotifQueue = {
    KEY: 'sk_notif_queue',

    enqueue: function(notif) {
      try {
        var q = this._read();
        /* Dedup by id */
        if (q.find(function(n) { return n.id === notif.id; })) return;
        q.push(notif);
        /* Keep at most 200 queued */
        if (q.length > 200) q = q.slice(-200);
        localStorage.setItem(this.KEY, JSON.stringify(q));
      } catch(e) {}
    },

    dequeueAll: function() {
      try {
        var q = this._read();
        localStorage.removeItem(this.KEY);
        return q;
      } catch(e) { return []; }
    },

    peek: function() {
      return this._read();
    },

    isDuplicate: function(id) {
      try {
        var seen = JSON.parse(localStorage.getItem('sk_notif_seen') || '{}');
        return !!seen[id];
      } catch(e) { return false; }
    },

    markSeen: function(id) {
      try {
        var seen = JSON.parse(localStorage.getItem('sk_notif_seen') || '{}');
        seen[id] = Date.now();
        /* Prune entries older than 7 days */
        var cutoff = Date.now() - 7 * 86400000;
        Object.keys(seen).forEach(function(k) { if (seen[k] < cutoff) delete seen[k]; });
        localStorage.setItem('sk_notif_seen', JSON.stringify(seen));
      } catch(e) {}
    },

    _read: function() {
      try { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); }
      catch(e) { return []; }
    }
  };

  /* ─────────────────────────────────────────────────────────────────────────
     AI NOTIFICATION GROUPER
     Reduces clutter by grouping similar notifications.
  ───────────────────────────────────────────────────────────────────────── */

  var NotifGrouper = {
    GROUP_WINDOW_MS: 30 * 60 * 1000,   /* 30 minutes */
    MIN_GROUP_SIZE:  3,                 /* min notifications to form a group */

    group: function(notifications) {
      var now = Date.now();
      var windowStart = now - this.GROUP_WINDOW_MS;
      var buckets = {};
      var groups  = [];
      var singles = [];

      notifications.forEach(function(n) {
        var age = n.createdAt ? (now - n.createdAt) : 0;
        var gk  = n.groupKey || (n.category + ':' + (n.type || 'default'));
        var inWindow = !n.createdAt || n.createdAt >= windowStart;

        /* Pinned notifications are never grouped */
        if (n.pinned || !inWindow) { singles.push(n); return; }

        if (!buckets[gk]) buckets[gk] = [];
        buckets[gk].push(n);
      });

      Object.keys(buckets).forEach(function(gk) {
        var items = buckets[gk];
        if (items.length >= NotifGrouper.MIN_GROUP_SIZE) {
          /* Form a group */
          var highest = items.reduce(function(acc, n) {
            return (PRIORITY_RANK[n.priority] || 3) > (PRIORITY_RANK[acc.priority] || 3) ? n : acc;
          }, items[0]);
          groups.push({
            isGroup:   true,
            id:        'grp_' + gk.replace(/[^a-z0-9]/gi, '_'),
            groupKey:  gk,
            count:     items.length,
            category:  items[0].category,
            priority:  highest.priority,
            icon:      items[0].icon || (CATEGORIES[items[0].category] || {}).icon || '🔔',
            title:     NotifGrouper._groupTitle(items),
            body:      items[0].body,
            createdAt: Math.max.apply(null, items.map(function(n) { return n.createdAt || 0; })),
            read:      items.every(function(n) { return n.read; }),
            items:     items
          });
        } else {
          items.forEach(function(n) { singles.push(n); });
        }
      });

      /* Sort combined: pinned first, then by time desc */
      var all = groups.concat(singles);
      all.sort(function(a, b) {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return  1;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });

      return all;
    },

    _groupTitle: function(items) {
      var cat = (CATEGORIES[items[0].category] || {}).label || items[0].category || 'Notifications';
      /* Common group title patterns */
      var typeMap = {
        'order_placed':   'New Orders',
        'order_status':   'Order Updates',
        'payment':        'Payments',
        'message':        'New Messages',
        'inventory_low':  'Inventory Alerts',
        'review':         'New Reviews',
        'delivery':       'Delivery Updates',
        'booking':        'New Bookings'
      };
      var type = items[0].type;
      var label = typeMap[type] || (cat + ' Updates');
      return items.length + ' ' + label;
    }
  };

  /* ─────────────────────────────────────────────────────────────────────────
     NOTIFICATION FATIGUE DETECTOR
     Suppresses low-priority notifications when user receives too many.
  ───────────────────────────────────────────────────────────────────────── */

  var FatigueDetector = {
    _window: [],

    record: function(priority) {
      var now = Date.now();
      /* Keep last hour only */
      this._window = this._window.filter(function(t) { return now - t < 3600000; });
      this._window.push(now);
    },

    isFatigued: function(priority, maxPerHour) {
      if (priority === PRIORITY.CRITICAL || priority === PRIORITY.HIGH) return false;
      var now = Date.now();
      var recent = this._window.filter(function(t) { return now - t < 3600000; }).length;
      return recent >= (maxPerHour || 30);
    }
  };

  /* ─────────────────────────────────────────────────────────────────────────
     MAIN ENGINE
  ───────────────────────────────────────────────────────────────────────── */

  var _listeners  = {};
  var _userId     = null;
  var _db         = null;
  var _unsubscribe = null;
  var _channel    = null;
  var _cache      = [];        /* In-memory notification cache */
  var _cacheTime  = 0;
  var _initialized = false;

  /* ── ID generator ── */
  function _genId() {
    return 'NTF-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* ── Emit to local listeners ── */
  function _emit(event, data) {
    (_listeners[event] || []).forEach(function(cb) {
      try { cb(data); } catch(e) {}
    });
  }

  /* ── Firebase init ── */
  function _initFirebase() {
    return new Promise(function(resolve) {
      var FB_CFG = {
        apiKey: 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE',
        authDomain: 'sokoni-aeb26.firebaseapp.com',
        projectId: 'sokoni-aeb26',
        storageBucket: 'sokoni-aeb26.firebasestorage.app',
        messagingSenderId: '24799054989',
        appId:"1:24799054989:web:e1cf6ca8c281bf1abf26c4",measurementId:"G-QT32H65TJS"};

      /* Try global firebase first */
      if (global.firebase) {
        try {
          var app = global.firebase.apps.length ? global.firebase.apps[0] : global.firebase.initializeApp(FB_CFG);
          resolve(global.firebase.firestore ? global.firebase.firestore() : null);
          return;
        } catch(e) {}
      }

      /* Dynamic import */
      Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
      ]).then(function(mods) {
        var initializeApp = mods[0].initializeApp;
        var getApps = mods[0].getApps;
        var getFirestore = mods[1].getFirestore;
        var app = getApps().length ? getApps()[0] : initializeApp(FB_CFG);
        resolve({ _modular: mods[1], _app: app, _fs: getFirestore(app) });
      }).catch(function() { resolve(null); });
    });
  }

  /* ── Normalize notification from Firestore to internal format ── */
  function _normalize(id, data) {
    var ts = data.createdAt;
    var tsMs = ts ? (ts.toMillis ? ts.toMillis() : (ts.seconds ? ts.seconds * 1000 : ts)) : Date.now();
    return {
      id:         id,
      targetUid:  data.targetUid || data.userId || _userId,
      category:   data.category   || _inferCategory(data.type),
      priority:   data.priority   || PRIORITY.NORMAL,
      type:       data.type        || 'generic',
      title:      data.heading     || data.title || '',
      body:       data.sub         || data.body  || '',
      icon:       data.icon        || (CATEGORIES[data.category || ''] || {}).icon || '🔔',
      actionUrl:  data.link        || data.actionUrl || 'notifications.html',
      groupKey:   data.groupKey    || (data.category || 'general') + ':' + (data.type || 'default'),
      actions:    data.actions     || _defaultActions(data),
      read:       !!data.read,
      archived:   !!data.archived,
      pinned:     !!data.pinned,
      createdAt:  tsMs,
      metadata:   data.metadata   || {}
    };
  }

  function _inferCategory(type) {
    if (!type) return 'system';
    var map = {
      order:    'orders', payment: 'payments', message: 'messages',
      delivery: 'deliveries', booking: 'bookings', inventory: 'inventory',
      employee: 'employees', security: 'security', verification: 'verification',
      finance:  'finance', support: 'support', ai: 'ai', promo: 'promotions',
      update:   'updates', pos: 'pos', business: 'business'
    };
    var key = Object.keys(map).find(function(k) { return type.toLowerCase().includes(k); });
    return key ? map[key] : 'system';
  }

  function _defaultActions(data) {
    var acts = [ACTIONS.MARK_READ, ACTIONS.ARCHIVE];
    if (data.link || data.actionUrl) acts.unshift(ACTIONS.VIEW);
    return acts;
  }

  /* ── Subscribe to real-time notifications ── */
  function _subscribe() {
    if (!_db || !_userId) return;

    function _startListener(fsModule) {
      try {
        var colRef, qRef;
        if (fsModule && fsModule._modular) {
          /* Modular SDK */
          var fs = fsModule;
          var col = fs._modular.collection(fs._fs, 'notifications');
          qRef = fs._modular.query(col,
            fs._modular.where('targetUid', '==', _userId),
            fs._modular.orderBy('createdAt', 'desc'),
            fs._modular.limit(100)
          );
          _unsubscribe = fs._modular.onSnapshot(qRef, _onSnapshot, function() {});
        } else if (_db.collection) {
          /* Compat SDK */
          qRef = _db.collection('notifications')
            .where('targetUid', '==', _userId)
            .orderBy('createdAt', 'desc')
            .limit(100);
          _unsubscribe = qRef.onSnapshot(_onSnapshot, function() {});
        }
      } catch(e) {}
    }

    _startListener(_db);
  }

  function _onSnapshot(snap) {
    var notifications = [];
    snap.forEach(function(doc) {
      notifications.push(_normalize(doc.id, doc.data()));
    });
    _cache    = notifications;
    _cacheTime = Date.now();

    var unreadCounts = _computeUnreadCounts(notifications);
    _emit('update', { notifications: notifications, unreadCounts: unreadCounts });
    _emit('unread_count', unreadCounts);

    /* Update legacy badge via shared-header shim */
    if (global.skNavSetUnread) {
      global.skNavSetUnread('notifications', unreadCounts.all || 0);
    }

    /* Cross-tab broadcast */
    if (_channel) {
      try { _channel.postMessage({ type: 'update', unreadCounts: unreadCounts }); }
      catch(e) {}
    }

    /* Sync offline queue */
    _syncQueue();
  }

  function _computeUnreadCounts(notifications) {
    var counts = { all: 0 };
    notifications.forEach(function(n) {
      if (!n.read && !n.archived) {
        counts.all++;
        counts[n.category] = (counts[n.category] || 0) + 1;
        if (PRIORITY_RANK[n.priority] >= PRIORITY_RANK[PRIORITY.HIGH]) {
          counts.important = (counts.important || 0) + 1;
        }
      }
    });
    return counts;
  }

  function _syncQueue() {
    var pending = NotifQueue.dequeueAll();
    if (!pending.length) return;
    /* Re-emit each queued notification */
    pending.forEach(function(n) {
      if (!NotifQueue.isDuplicate(n.id)) {
        SokoniNotifEngine._writeToFirestore(n);
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────────────────────── */

  var SokoniNotifEngine = {
    PRIORITY:   PRIORITY,
    CATEGORIES: CATEGORIES,
    PANEL_CATEGORIES: PANEL_CATEGORIES,
    PREF_CATEGORIES: PREF_CATEGORIES,
    ACTIONS:    ACTIONS,
    prefs:      NotifPrefs,
    queue:      NotifQueue,
    grouper:    NotifGrouper,

    /**
     * Initialize the engine.
     * @param {string} userId — Firebase Auth UID (null for guest)
     */
    init: function(userId) {
      _userId = userId || null;
      NotifPrefs.load(_userId, null);  /* Prefs load from localStorage immediately */

      /* Initialize Firebase and start listener */
      _initFirebase().then(function(db) {
        _db = db;
        NotifPrefs._db = db;
        if (_userId && db) {
          NotifPrefs._syncFromFirestore();
          _subscribe();
        }
      });

      /* Cross-tab BroadcastChannel */
      if ('BroadcastChannel' in global) {
        try {
          _channel = new BroadcastChannel('sk_notif');
          _channel.onmessage = function(e) {
            if (e.data && e.data.type === 'update') {
              _emit('unread_count', e.data.unreadCounts);
            }
          };
        } catch(e) {}
      }

      /* Online recovery — sync queue when internet returns */
      global.addEventListener('online', function() {
        _syncQueue();
        if (!_unsubscribe && _db && _userId) _subscribe();
      });

      _initialized = true;
      return this;
    },

    /* ── Query API ── */

    /**
     * Get filtered notifications.
     * @param {object} [opts]
     * @param {string}  [opts.category]  — category to filter by ('all' = no filter)
     * @param {boolean} [opts.unreadOnly]
     * @param {boolean} [opts.archivedOnly]
     * @param {string}  [opts.search]   — search term
     * @param {string}  [opts.priority] — filter by priority
     * @param {boolean} [opts.grouped]  — apply AI grouping
     */
    getAll: function(opts) {
      opts = opts || {};
      var list = _cache.slice();

      if (opts.archivedOnly) {
        list = list.filter(function(n) { return n.archived; });
      } else {
        list = list.filter(function(n) { return !n.archived; });
      }

      if (opts.category && opts.category !== 'all' && opts.category !== 'unread' && opts.category !== 'important') {
        list = list.filter(function(n) { return n.category === opts.category; });
      }
      if (opts.category === 'unread') {
        list = list.filter(function(n) { return !n.read; });
      }
      if (opts.category === 'important') {
        list = list.filter(function(n) {
          return PRIORITY_RANK[n.priority] >= PRIORITY_RANK[PRIORITY.HIGH];
        });
      }
      if (opts.unreadOnly) {
        list = list.filter(function(n) { return !n.read; });
      }
      if (opts.priority) {
        list = list.filter(function(n) { return n.priority === opts.priority; });
      }
      if (opts.search) {
        var q = opts.search.toLowerCase();
        list = list.filter(function(n) {
          return (n.title + ' ' + n.body).toLowerCase().includes(q);
        });
      }

      if (opts.grouped !== false) {
        list = NotifGrouper.group(list);
      }

      return list;
    },

    getUnreadCounts: function() {
      return _computeUnreadCounts(_cache);
    },

    getUnreadCount: function(category) {
      var counts = this.getUnreadCounts();
      return category ? (counts[category] || 0) : (counts.all || 0);
    },

    /* ── Actions ── */

    markRead: function(id) {
      return this._update(id, { read: true });
    },

    markAllRead: function(category) {
      var ids = _cache
        .filter(function(n) {
          return !n.read && !n.archived && (!category || category === 'all' || n.category === category);
        })
        .map(function(n) { return n.id; });
      return Promise.all(ids.map(function(id) { return SokoniNotifEngine._update(id, { read: true }); }));
    },

    markGroupRead: function(group) {
      if (!group || !group.items) return Promise.resolve();
      return Promise.all(group.items.map(function(n) {
        return SokoniNotifEngine.markRead(n.id);
      }));
    },

    archive: function(id) {
      return this._update(id, { archived: true });
    },

    archiveGroup: function(group) {
      if (!group || !group.items) return Promise.resolve();
      return Promise.all(group.items.map(function(n) {
        return SokoniNotifEngine.archive(n.id);
      }));
    },

    pin: function(id) {
      var n = _cache.find(function(n) { return n.id === id; });
      return this._update(id, { pinned: n ? !n.pinned : true });
    },

    delete: function(id) {
      return this._delete(id);
    },

    archiveAll: function() {
      var ids = _cache.filter(function(n) { return !n.archived; }).map(function(n) { return n.id; });
      return Promise.all(ids.map(function(id) { return SokoniNotifEngine.archive(id); }));
    },

    /**
     * Create and push a new notification.
     * @param {object} opts — notification options
     * @param {string} opts.targetUid — recipient user ID
     * @param {string} opts.category
     * @param {string} opts.priority
     * @param {string} opts.type
     * @param {string} opts.title
     * @param {string} opts.body
     * @param {string} [opts.icon]
     * @param {string} [opts.actionUrl]
     * @param {string} [opts.groupKey]
     * @param {object[]} [opts.actions]
     * @param {object} [opts.metadata]
     */
    push: function(opts) {
      var notif = {
        id:         opts.id || _genId(),
        targetUid:  opts.targetUid || opts.userId || _userId,
        category:   opts.category  || 'system',
        priority:   opts.priority  || PRIORITY.NORMAL,
        type:       opts.type      || 'generic',
        heading:    opts.title     || opts.heading || '',
        sub:        opts.body      || opts.sub     || '',
        icon:       opts.icon      || (CATEGORIES[opts.category || 'system'] || {}).icon || '🔔',
        link:       opts.actionUrl || opts.link    || 'notifications.html',
        groupKey:   opts.groupKey  || (opts.category || 'system') + ':' + (opts.type || 'default'),
        actions:    opts.actions   || [],
        read:       false,
        archived:   false,
        pinned:     false,
        metadata:   opts.metadata  || {},
        createdAt:  new Date()
      };

      /* Dedup check */
      if (NotifQueue.isDuplicate(notif.id)) return Promise.resolve(null);
      NotifQueue.markSeen(notif.id);

      /* Check allowance */
      if (!NotifPrefs.isAllowed(notif.category, notif.priority)) {
        return Promise.resolve(null);
      }

      /* Fatigue check */
      if (FatigueDetector.isFatigued(notif.priority, (NotifPrefs.get().fatigue || {}).maxCount)) {
        return Promise.resolve(null);
      }
      FatigueDetector.record(notif.priority);

      /* Offline: queue locally */
      if (!navigator.onLine) {
        NotifQueue.enqueue(notif);
        return Promise.resolve(notif);
      }

      return this._writeToFirestore(notif);
    },

    /* ── Internal Firestore helpers ── */

    _update: function(id, updates) {
      /* Optimistic update in cache */
      var n = _cache.find(function(n) { return n.id === id; });
      if (n) Object.assign(n, updates);

      if (!_db) return Promise.resolve();
      try {
        if (_db._modular) {
          var ref = _db._modular.doc(_db._fs, 'notifications', id);
          return _db._modular.updateDoc(ref, updates).catch(function() {});
        } else if (_db.collection) {
          return _db.collection('notifications').doc(id).update(updates).catch(function() {});
        }
      } catch(e) {}
      return Promise.resolve();
    },

    _delete: function(id) {
      _cache = _cache.filter(function(n) { return n.id !== id; });
      if (!_db) return Promise.resolve();
      try {
        if (_db._modular) {
          return _db._modular.deleteDoc(_db._modular.doc(_db._fs, 'notifications', id)).catch(function() {});
        } else if (_db.collection) {
          return _db.collection('notifications').doc(id).delete().catch(function() {});
        }
      } catch(e) {}
      return Promise.resolve();
    },

    _writeToFirestore: function(notif) {
      if (!_db) { NotifQueue.enqueue(notif); return Promise.resolve(notif); }
      try {
        if (_db._modular) {
          var ref = _db._modular.doc(_db._fs, 'notifications', notif.id);
          return _db._modular.setDoc(ref, notif).then(function() { return notif; }).catch(function() {
            NotifQueue.enqueue(notif); return notif;
          });
        } else if (_db.collection) {
          return _db.collection('notifications').doc(notif.id).set(notif)
            .then(function() { return notif; })
            .catch(function() { NotifQueue.enqueue(notif); return notif; });
        }
      } catch(e) { NotifQueue.enqueue(notif); }
      return Promise.resolve(notif);
    },

    /* ── Event subscriptions ── */

    on: function(event, cb) {
      if (!_listeners[event]) _listeners[event] = [];
      if (_listeners[event].indexOf(cb) < 0) _listeners[event].push(cb);
      return function() {
        _listeners[event] = (_listeners[event] || []).filter(function(f) { return f !== cb; });
      };
    },

    _emit: _emit,

    /* ── Utilities ── */
    formatTime: function(ts) {
      if (!ts) return '';
      var d   = new Date(ts);
      var now = new Date();
      var diff = now - d;
      if (diff < 60000)     return 'Just now';
      if (diff < 3600000)   return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000)  return Math.floor(diff / 3600000) + 'h ago';
      if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
      return d.toLocaleDateString('en-KE', { month: 'short', day: 'numeric' });
    },

    isInitialized: function() { return _initialized; }
  };

  /* Expose */
  global.SokoniNotifEngine = SokoniNotifEngine;

  /* Auto-init if user session exists */
  (function() {
    function _tryInit() {
      try {
        var stored = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
        var uid = stored && stored.uid ? stored.uid : null;
        SokoniNotifEngine.init(uid);
      } catch(e) {
        SokoniNotifEngine.init(null);
      }
    }
    if (document.readyState !== 'loading') { setTimeout(_tryInit, 0); }
    else { document.addEventListener('DOMContentLoaded', _tryInit, { once: true }); }
  })();

})(window);
