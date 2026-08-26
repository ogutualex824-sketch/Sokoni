/* ══════════════════════════════════════════════════════════════════════════
   SOKONI premium composer — emoji panel + Quick Say
   ──────────────────────────────────────────────────────────────────────────
   Deliberately NOT a keyboard replacement. Both surfaces sit ABOVE the
   textarea and only INSERT text, so the native keyboard keeps handling
   typing, languages, autocorrect, accessibility and voice input.
   Nothing here auto-sends: the user always presses send.

   Sending is untouched and still goes through the existing sendMessage Cloud
   Function. Direct client writes to messages are blocked by rules (MSG-1),
   so this adds no second write path.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  var LS_RECENT = "sk_emoji_recent";
  var CATS = [
    { id: "recent",   tab: "🕘",  label: "Recent",     list: "" },
    { id: "smileys",  tab: "😀",  label: "Smileys",    list: "😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😙🥲😋😛😜🤪😝🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬😌😔😪🤤😴😷🤒🤕🥴😵🤯🤠🥳😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈💀" },
    { id: "people",   tab: "👋",  label: "People",     list: "👋🤚🖐️✋🖖👌🤌🤏✌️🤞🤟🤘🤙👈👉👆👇☝️👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏💪🦾👂👃🧠👀👁️👅👄💋🧑👶👦👧👨👩🧓👴👵🙅🙆💁🙋🙇🤦🤷👮🕵️💂👷🤴👸🧕🤵👰🤰🤱👼🦸🦹" },
    { id: "hearts",   tab: "❤️",  label: "Hearts",     list: "❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💟♥️💌💐🌹🌺🌸🌼🌻✨⭐🌟💫⚡🔥💥💯" },
    { id: "animals",  tab: "🐶",  label: "Animals",    list: "🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🙈🙉🙊🐒🐔🐧🐦🐤🦆🦅🦉🦇🐺🐗🐴🦄🐝🐛🦋🐌🐞🐜🕷️🐢🐍🦎🦖🦕🐙🦑🦐🦀🐡🐠🐟🐬🐳🐋🦈🐊🐅🐆🦓🦍🐘🦛🦏🐪🐫🦒🦘🐄🐎🐖🐑🦙🐐🦌🐕🐈🐓🦃🦚🦜🕊️🐇🦔" },
    { id: "food",     tab: "🍔",  label: "Food",       list: "🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍈🍒🍑🥭🍍🥥🥝🍅🍆🥑🥦🥬🥒🌶️🫑🌽🥕🧄🧅🥔🍠🥐🥯🍞🥖🥨🧀🥚🍳🥞🧇🥓🥩🍗🍖🌭🍔🍟🍕🥪🥙🌮🌯🥗🥘🍝🍜🍲🍛🍣🍱🥟🍤🍙🍚🍥🍢🍡🍧🍨🍦🥧🧁🍰🎂🍮🍭🍬🍫🍿🍩🍪☕🍵🧃🥤🧋🍺🍻🥂🍷🥃🍸🍹" },
    { id: "activity", tab: "⚽",  label: "Activities", list: "⚽🏀🏈⚾🥎🎾🏐🏉🥏🎱🏓🏸🏒🏑🏏🥅⛳🏹🎣🥊🥋🎽🛹🛼⛸️🎿⛷️🏂🏋️🤼🤸⛹️🤾🏌️🏇🧘🏄🏊🚣🧗🚵🚴🏆🥇🥈🥉🏅🎖️🎫🎪🤹🎭🎨🎬🎤🎧🎼🎹🥁🎷🎺🎸🎻🎲♟️🎯🎳🎮🧩" },
    { id: "travel",   tab: "🚗",  label: "Travel",     list: "🚗🚕🚙🚌🚎🏎️🚓🚑🚒🚐🛻🚚🚛🚜🛴🚲🛵🏍️🛺🚨🚔🚍🚘🚖🚡🚠🚟🚃🚋🚞🚝🚄🚅🚈🚂🚆🚇🚊🚉✈️🛫🛬🛩️💺🛰️🚀🚁🛶⛵🚤🛥️🛳️⛴️🚢⚓⛽🚧🚦🚥🗺️🗿🗽🗼🏰🏟️🎡🎢🎠⛲🏖️🏝️🏜️🌋⛰️🏔️🏕️⛺🏠🏡🏘️🏗️🏭🏢🏬🏣🏤🏥🏦🏨🏪🏫🏩⛪🕌🕍🛕" },
    { id: "objects",  tab: "💡",  label: "Objects",    list: "⌚📱📲💻⌨️🖥️🖨️🖱️🕹️💽💾💿📀📼📷📸📹🎥📽️📞☎️📟📠📺📻🎙️🎚️🎛️🧭⏱️⏲️⏰🕰️⌛⏳📡🔋🔌💡🔦🕯️🧯💸💵💴💶💷🪙💰💳💎⚖️🧰🔧🔨⚒️🛠️⛏️🔩⚙️🧱⛓️🧲🔫💣🪓🔪🗡️🛡️⚰️🏺🔮📿💈⚗️🔭🔬🩹🩺💊💉🩸🧬🦠🧪🌡️🧹🧺🧻🚽🚰🚿🛁🧼🪥🧽🛎️🔑🗝️🚪🪑🛋️🛏️🧸🖼️🛍️🛒🎁🎈🎀" },
    { id: "symbols",  tab: "🔣",  label: "Symbols",    list: "✅❌❎➕➖➗✖️❓❔❕❗〰️💱💲⚕️♻️⚜️🔱📛🔰⭕✔️☑️🔘🔴🟠🟡🟢🔵🟣⚫⚪🟤🔺🔻🔸🔹🔶🔷🔳🔲▪️▫️◼️◻️⬛⬜🔈🔉🔊🔇📢📣📯🔔🔕🎵🎶💬💭🗯️♠️♥️♦️♣️🃏🔠🔡🔢🔣🔤🆎🆑🆒🆓ℹ️🆔🆕🆖🆗🆘🆙🆚" },
    { id: "stickers", tab: "🧩", label: "Stickers", list: "" },
    { id: "flags",    tab: "🇰🇪", label: "Flags",      list: "🇰🇪🇺🇬🇹🇿🇷🇼🇧🇮🇸🇸🇪🇹🇸🇴🇳🇬🇬🇭🇿🇦🇪🇬🇲🇦🇩🇿🇹🇳🇸🇩🇨🇩🇨🇲🇨🇮🇸🇳🇲🇱🇧🇫🇳🇪🇹🇩🇿🇲🇿🇼🇧🇼🇳🇦🇲🇺🇸🇨🇲🇬🇦🇴🇲🇿🇬🇧🇺🇸🇨🇦🇦🇺🇮🇳🇨🇳🇯🇵🇰🇷🇩🇪🇫🇷🇮🇹🇪🇸🇳🇱🇸🇪🇳🇴🇩🇰🇫🇮🇵🇱🇷🇺🇹🇷🇸🇦🇦🇪🇶🇦🇧🇷🇦🇷🇲🇽🏳️🏴🏁🚩" }
  ];

  function ta() { return document.getElementById("msgInput"); }

  /* Insert at the caret so the panel composes WITH typing rather than replacing
     it, and keep focus on the textarea so the native keyboard stays up. */
  function insertAtCaret(txt) {
    var el = ta();
    if (!el) return;
    var s = el.selectionStart == null ? el.value.length : el.selectionStart;
    var e = el.selectionEnd == null ? s : el.selectionEnd;
    el.value = el.value.slice(0, s) + txt + el.value.slice(e);
    var pos = s + txt.length;
    try { el.setSelectionRange(pos, pos); } catch (_) {}
    el.focus();
    /* keeps the existing autosize / send-enabled logic in sync */
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function recents() {
    try { return JSON.parse(localStorage.getItem(LS_RECENT) || "[]"); } catch (_) { return []; }
  }
  function pushRecent(ch) {
    try {
      var r = recents().filter(function (x) { return x !== ch; });
      r.unshift(ch);
      localStorage.setItem(LS_RECENT, JSON.stringify(r.slice(0, 32)));
    } catch (_) { /* private mode: recents are a convenience, never a dependency */ }
  }

  var active = "smileys";
  function chars(cat) {
    if (cat.id === "recent") return recents();
    if (cat.id === "stickers") {
      /* flatten the packs; the grid renders them at sticker size via .sk-stk */
      return (window.SokoniStickers ? window.SokoniStickers.packs() : [])
        .reduce(function (a, p) { return a.concat(p.list); }, []);
    }
    return Array.from(cat.list);
  }

  function renderGrid(filter) {
    var grid = document.getElementById("sk-emoji-grid");
    if (!grid) return;
    var html = "";
    var show = filter ? CATS.filter(function (c) { return c.id !== "recent"; })
                      : CATS.filter(function (c) { return c.id === active; });
    show.forEach(function (c) {
      if (filter) {
        var f = filter.toLowerCase();
        /* Category-label search: matches what a user actually types ("food",
           "flag", "heart"). No per-emoji name table is shipped, so the search
           is honest about its scope rather than pretending to know names. */
        if (c.label.toLowerCase().indexOf(f) < 0 && c.id.indexOf(f) < 0) return;
      }
      var list = chars(c);
      if (!list.length) return;
      if (filter) html += '<div class="sk-cat">' + c.label + "</div>";
      list.forEach(function (ch) {
        html += '<button type="button" data-e="' + ch + '" aria-label="' + ch + '">' + ch + "</button>";
      });
    });
    grid.innerHTML = html || '<div class="sk-cat">No matches</div>';
  }

  function renderTabs() {
    var t = document.getElementById("sk-emoji-tabs");
    if (!t) return;
    t.innerHTML = CATS.map(function (c) {
      return '<button type="button" data-c="' + c.id + '" class="' + (c.id === active ? "on" : "") +
             '" title="' + c.label + '" aria-label="' + c.label + '">' + c.tab + "</button>";
    }).join("");
  }

  window.skToggleEmoji = function () {
    var p = document.getElementById("sk-emoji");
    var b = document.getElementById("btn-emoji");
    if (!p) return;
    var open = p.classList.toggle("open");
    if (b) b.setAttribute("aria-expanded", String(open));
    if (open) { renderTabs(); renderGrid(""); }
  };

  /* ── Quick Say ──────────────────────────────────────────────────────────
     Time-of-day aware, and role aware where the page already knows the
     counterparty. INSERT ONLY — a suggestion is never sent on your behalf. */
  function phrases() {
    var h = new Date().getHours();
    var part = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
    var greet = part === "morning" ? "☀️ Good morning!"
              : part === "afternoon" ? "🌤️ Good afternoon!" : "🌙 Good evening!";
    var seller = !!(window.SK_CONV_ROLE === "seller" ||
                    (document.body && document.body.dataset && document.body.dataset.convRole === "seller"));
    if (seller) {
      return [greet, "🛍️ Hi! How can we help?", "📦 Your order is ready",
              "🚚 Your rider is on the way", "🙏 Thank you for shopping with us"];
    }
    if (part === "morning")   return [greet, "👋 Hello!", "😊 How can I help?", "🙏 Thank you!", "📦 Order update"];
    if (part === "afternoon") return [greet, "👋 Hello!", "🙏 Thank you!", "📦 Order update", "🚚 Delivery update"];
    return [greet, "😊 Thanks for shopping!", "🙏 Thank you!", "📦 Order update", "🚚 Delivery update"];
  }

  function renderQuickSay() {
    var bar = document.getElementById("sk-quicksay");
    if (!bar) return;
    bar.innerHTML = phrases().map(function (p, i) {
      return '<button type="button" class="qs' + (i === 0 ? " qs-greet" : "") + '">' + p + "</button>";
    }).join("");
  }

  /* Delegated listeners: the grid re-renders constantly, so per-button handlers
     would leak. One listener per concern instead. */
  document.addEventListener("click", function (ev) {
    if (!ev.target || !ev.target.closest) return;
    var b = ev.target.closest("#sk-emoji-grid button[data-e]");
    if (b) { var ch = b.getAttribute("data-e"); insertAtCaret(ch); pushRecent(ch); return; }
    var t = ev.target.closest("#sk-emoji-tabs button[data-c]");
    if (t) {
      active = t.getAttribute("data-c");
      var q = document.getElementById("sk-emoji-search");
      if (q) q.value = "";
      renderTabs(); renderGrid(""); return;
    }
    var qs = ev.target.closest("#sk-quicksay .qs");
    if (qs) {
      var el = ta();
      var lead = (el && el.value && !/\s$/.test(el.value)) ? " " : "";
      insertAtCaret(lead + qs.textContent.trim());
    }
  }, false);

  document.addEventListener("input", function (ev) {
    if (ev.target && ev.target.id === "sk-emoji-search") renderGrid(ev.target.value.trim());
  }, false);

  function init() { renderQuickSay(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
  /* refresh the greeting if the tab is left open across a time boundary */
  setInterval(renderQuickSay, 15 * 60 * 1000);
})();

/* ══════════════════════════════════════════════════════════════════════════
   SOKONI delivery / order cards
   ──────────────────────────────────────────────────────────────────────────
   Renders a RICHER VIEW of a system message the server already posted. It is
   presentation only:

     • it never writes delivery or order state
     • it never infers status the server did not send
     • unknown or unrecognised status falls back to the plain pill, so a status
       this renderer has not seen is shown as-is rather than mislabelled

   The delivery authority remains the order/delivery records. This reads the
   message the server produced from them and nothing else.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* Only statuses the server demonstrably emits are given a card. Anything
     else stays a plain system pill — a card that guessed would be exactly the
     "chat as a second source of delivery truth" this must not become. */
  var CARD = {
    rider_assigned:   { icon: "🚚", title: "Delivery update",  line: "Rider assigned" },
    out_for_delivery: { icon: "🚚", title: "Delivery update",  line: "Out for delivery" },
    in_transit:       { icon: "🚚", title: "Delivery update",  line: "In transit" },
    picked_up:        { icon: "📦", title: "Delivery update",  line: "Picked up" },
    delivered:        { icon: "✅", title: "Delivered",        line: "Delivery complete" },
    ready:            { icon: "📦", title: "Order update",     line: "Order is ready" },
    dispatched:       { icon: "🚚", title: "Delivery update",  line: "Dispatched" }
  };

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* The card only claims what the message carries. Route/eta/rider are shown
     when present and simply omitted otherwise — never invented, never zero. */
  window.skDeliveryCardHtml = function (msg) {
    if (!msg || msg.type !== "system") return null;
    var key = String(msg.deliveryStatus || msg.statusKey || "").toLowerCase();
    var c = CARD[key];
    if (!c) return null;                       /* unknown status -> plain pill */

    var from = msg.fromName || msg.sellerName || "";
    var to   = msg.toName   || msg.destinationName || "";
    var route = (from && to) ? esc(from) + " → " + esc(to) : "";
    var trackId = msg.deliveryId || msg.dispatchId || "";

    return '<div class="sk-dlv-card">' +
             '<div class="sk-dlv-h">' + c.icon + " " + esc(c.title) + "</div>" +
             (route ? '<div class="sk-dlv-route">' + route + "</div>" : "") +
             '<div class="sk-dlv-line">' + esc(c.line) + "</div>" +
             (trackId
               ? '<a class="sk-dlv-cta" href="delivery-tracking.html?id=' +
                 encodeURIComponent(trackId) + '">Track delivery →</a>'
               : "") +
           "</div>";
  };
})();

/* ══════════════════════════════════════════════════════════════════════════
   SOKONI message favourites / pins
   ──────────────────────────────────────────────────────────────────────────
   PER-USER VIEW STATE, deliberately local, for the same reason as the
   conversation list: the messages rule blocks direct client creates entirely
   (MSG-1) and permits only a narrow soft-edit on update, so a favourite flag
   written onto the message document would be REJECTED. Storing locally is
   honest about that rather than shipping a star that silently fails.

   Stated consequence: favourites and pins do NOT sync across devices. They are
   a personal index over a conversation, not conversation data.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  var K_FAV = "sk_msg_favs", K_PIN = "sk_msg_pins";

  function get(k) { try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch (_) { return {}; } }
  function set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

  /* Keyed by conversation so a personal index stays scoped to the conversation
     it belongs to — the same boundary the server enforces for the messages. */
  function convKey() {
    try { return new URLSearchParams(location.search).get("id") || "_"; } catch (_) { return "_"; }
  }
  function listFor(k) { var all = get(k); return all[convKey()] || []; }
  function toggle(k, id) {
    var all = get(k), c = convKey(), a = all[c] || [], i = a.indexOf(id);
    if (i >= 0) a.splice(i, 1); else a.push(id);
    all[c] = a; set(k, all);
    return i < 0;
  }

  window.SokoniMsgMarks = {
    isFav:  function (id) { return listFor(K_FAV).indexOf(id) >= 0; },
    isPin:  function (id) { return listFor(K_PIN).indexOf(id) >= 0; },
    favs:   function () { return listFor(K_FAV).slice(); },
    pins:   function () { return listFor(K_PIN).slice(); },
    toggleFav: function (id) { return toggle(K_FAV, id); },
    togglePin: function (id) { return toggle(K_PIN, id); },
    /* Menu entries for the existing long-press context menu. Labels reflect
       current state so the action is never ambiguous. */
    menuItems: function (msg, onDone) {
      if (!msg || !msg.id) return [];
      var f = this.isFav(msg.id), p = this.isPin(msg.id), self = this;
      return [
        { label: f ? "Unfavourite" : "Favourite", icon: "star",
          fn: function () { self.toggleFav(msg.id); if (onDone) onDone(); } },
        { label: p ? "Unpin" : "Pin", icon: "push_pin",
          fn: function () { self.togglePin(msg.id); if (onDone) onDone(); } }
      ];
    }
  };
})();

/* ── Favourites view ──────────────────────────────────────────────────────
   A filter over what is already rendered, not a second data source: it toggles
   a body class and CSS hides unmarked rows. No fetch, no write, and the thread
   is untouched underneath, so leaving the view restores everything exactly. */
(function () {
  "use strict";
  window.skToggleFavsView = function () {
    var on = document.body.classList.toggle("sk-favs-only");
    var btn = document.getElementById("btn-favs-toggle");
    if (btn) btn.setAttribute("aria-pressed", String(on));

    /* An empty state only makes sense inside the view. Created lazily so the
       normal thread carries no extra node. */
    var empty = document.getElementById("sk-favs-empty");
    if (on) {
      var marked = document.querySelectorAll(".msg-row.sk-marked").length;
      if (!empty) {
        empty = document.createElement("div");
        empty.id = "sk-favs-empty";
        empty.textContent = "No favourite messages yet. Long-press a message and choose Favourite.";
        var host = document.querySelector(".msg-row") ? document.querySelector(".msg-row").parentNode : document.body;
        host.appendChild(empty);
      }
      empty.style.display = marked ? "none" : "block";
    } else if (empty) {
      empty.style.display = "none";
    }
    return on;
  };
})();

/* ══════════════════════════════════════════════════════════════════════════
   Tap reactions
   ──────────────────────────────────────────────────────────────────────────
   Unlike favourites/pins (which are personal and local), reactions are shared
   conversation data, so they go through the server: SokoniChat.reactToMessage
   → messagesDispatch → the participant-scoped, allowlisted handler.

   The optimistic paint is deliberately reverted if the call fails. A reaction
   that appears to land and silently did not would be the same false-success
   pattern this codebase has been removing elsewhere.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  /* Must match _ALLOWED_REACTIONS server-side; anything else is rejected. */
  var SET = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🙏", "✅"];

  window.SokoniReactions = {
    palette: function () { return SET.slice(); },

    /* Renders the counts the SERVER stored. Never derives or inflates: the
       reactions map is keyed by uid, one entry per user. */
    barHtml: function (msg, myUid) {
      if (!msg || !msg.reactions) return "";
      var counts = {}, mine = null;
      Object.keys(msg.reactions).forEach(function (uid) {
        var e = msg.reactions[uid];
        if (!e) return;
        counts[e] = (counts[e] || 0) + 1;
        if (uid === myUid) mine = e;
      });
      var keys = Object.keys(counts);
      if (!keys.length) return "";
      return '<div class="sk-rx">' + keys.map(function (e) {
        return '<span class="sk-rx-chip' + (mine === e ? " mine" : "") + '">' +
               e + '<b>' + counts[e] + "</b></span>";
      }).join("") + "</div>";
    },

    /* Toggle: sending the emoji already set removes it (server treats null as
       remove, and one-per-user means re-sending the same value is a no-op). */
    toggle: function (convId, msg, emoji, myUid, onDone) {
      if (!window.SokoniChat || !window.SokoniChat.reactToMessage) return;
      var current = (msg.reactions || {})[myUid] || null;
      var next = (current === emoji) ? null : emoji;
      var prev = msg.reactions ? JSON.parse(JSON.stringify(msg.reactions)) : {};

      /* optimistic */
      msg.reactions = msg.reactions || {};
      if (next === null) delete msg.reactions[myUid]; else msg.reactions[myUid] = next;
      if (onDone) onDone();

      window.SokoniChat.reactToMessage(convId, msg.id, next).catch(function (e) {
        /* revert — the server refused (not a participant, deleted message,
           emoji not allowlisted). Showing the reaction anyway would be a lie. */
        msg.reactions = prev;
        if (onDone) onDone();
        if (window.showToast) window.showToast("Could not add reaction: " + (e && e.message ? e.message : "failed"), true);
        else console.warn("[reactions]", e && e.message);
      });
    }
  };
})();

/* ══════════════════════════════════════════════════════════════════════════
   Stickers
   ──────────────────────────────────────────────────────────────────────────
   Implemented as EMOJI-ONLY TEXT MESSAGES rendered large, not as a new message
   type: _ALLOWED_MSG_TYPES is ['text','image','video','voice','audio','file',
   'location'] and sendMessage REJECTS anything else, so a 'sticker' type would
   fail server-side. Sending text keeps one write path and one retention story.

   Sticker taps INSERT into the composer like everything else here — the user
   still presses send. Nothing is sent on your behalf.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  var PACKS = [
    { name: "Reactions", list: ["👍", "👏", "🙌", "🤝", "🙏", "💯", "🔥", "✨", "🎉", "❤️", "😂", "😍"] },
    { name: "Shopping",  list: ["🛍️", "🛒", "📦", "🏷️", "💳", "💰", "🧾", "🎁", "⭐", "✅", "🆕", "🔖"] },
    { name: "Delivery",  list: ["🚚", "🚴", "🛵", "📍", "🗺️", "⏱️", "📮", "🏠", "🚦", "🧭", "📲", "🕐"] },
    { name: "Kenya",     list: ["🇰🇪", "☕", "🌍", "🦁", "🐘", "🦒", "🌅", "🏔️", "🌴", "🥭", "🍌", "🌽"] }
  ];

  window.SokoniStickers = {
    packs: function () { return PACKS.map(function (p) { return { name: p.name, list: p.list.slice() }; }); },

    /* A message is a "sticker" when its text is nothing but emoji and short.
       Detection is presentational only — the stored message is ordinary text,
       so nothing downstream (search, retention, moderation) has to know. */
    isSticker: function (text) {
      if (!text) return false;
      var t = String(text).trim();
      if (!t || t.length > 12) return false;
      /* strip emoji, variation selectors, ZWJ and skin-tone modifiers */
      var stripped = t.replace(/[\u200D\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, "")
                      .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, "");
      return stripped.trim().length === 0;
    },

    panelHtml: function () {
      return PACKS.map(function (p) {
        return '<div class="sk-cat">' + p.name + "</div>" +
               p.list.map(function (e) {
                 return '<button type="button" class="sk-stk" data-e="' + e + '" aria-label="' + e + '">' + e + "</button>";
               }).join("");
      }).join("");
    }
  };
})();

/* ══════════════════════════════════════════════════════════════════════════
   Rider-selection card
   ──────────────────────────────────────────────────────────────────────────
   "🚴 Choose your delivery rider — 3 riders available — From KSh … · … km · … min"

   Presentation of an offer the DELIVERY AUTHORITY produced. Same discipline as
   the delivery-update card:
     • every figure comes from the message; nothing is computed here
     • a missing price/distance/eta is OMITTED, never shown as 0 or "—"
     • with no offers it renders nothing rather than an empty shell
     • "Choose rider" links into the existing delivery surface; the choice is
       made there, not in chat
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  /* Only formats what is actually a finite number. A missing figure must not
     become "KSh 0" — an invented price is worse than an absent one. */
  function num(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }
  function kes(v) { var n = num(v); return n === null ? null : "KSh " + n.toLocaleString("en-KE"); }

  window.skRiderOfferCardHtml = function (msg) {
    if (!msg || msg.type !== "system") return null;
    var offers = msg.riderOffers || msg.offers;
    if (!Array.isArray(offers) || !offers.length) return null;

    /* cheapest quoted offer leads the summary, when any offer carries a price */
    var prices = offers.map(function (o) { return num(o && o.priceKES); })
                       .filter(function (n) { return n !== null; });
    var from = prices.length ? kes(Math.min.apply(null, prices)) : null;

    var dists = offers.map(function (o) { return num(o && o.distanceKm); })
                      .filter(function (n) { return n !== null; });
    var etas  = offers.map(function (o) { return num(o && o.etaMinutes); })
                      .filter(function (n) { return n !== null; });

    var bits = [];
    if (from)         bits.push("From " + esc(from));
    if (dists.length) bits.push(esc(Math.min.apply(null, dists)) + " km");
    if (etas.length)  bits.push(esc(Math.min.apply(null, etas)) + " min");

    var deliveryId = msg.deliveryId || msg.dispatchId || "";
    return '<div class="sk-dlv-card sk-rider-card">' +
             '<div class="sk-dlv-h">🚴 Choose your delivery rider</div>' +
             '<div class="sk-dlv-route">' + offers.length +
               (offers.length === 1 ? " rider available" : " riders available") + "</div>" +
             (bits.length ? '<div class="sk-dlv-line">' + bits.join(" · ") + "</div>" : "") +
             (deliveryId
               ? '<a class="sk-dlv-cta" href="delivery.html?id=' + encodeURIComponent(deliveryId) +
                 '">Choose rider</a>'
               : "") +
           "</div>";
  };
})();
