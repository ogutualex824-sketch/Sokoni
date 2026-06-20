/* ================================================================
   SOKONI — AI Contact Guard  v1.0
   Detects and masks private contact information shared in chat
   and community posts by users who haven't paid for a boost.

   Protects the platform economy by ensuring all business stays
   on Sokoni — fair for sellers who invest in visibility.
================================================================ */

const ContactGuard = (function () {

  /* ──────────────────────────────────────────
     1.  DETECTION PATTERNS
  ────────────────────────────────────────── */

  /* Kenya / East Africa phone numbers
     Covers: 07XX XXX XXX · 01XX XXX XXX · +254 7XX ... */
  const RE_PHONE = /(\+?254|0)([17][0-9]{2})([\s\-]?)([0-9]{3})([\s\-]?)([0-9]{3,4})/g;

  /* International dialling (+1, +44, +255 Tanzania, +256 Uganda …) */
  const RE_INTL  = /\+(?!254)[1-9][0-9]{0,3}[\s\-]?([0-9][\s\-]?){7,13}/g;

  /* Email */
  const RE_EMAIL = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

  /* WhatsApp deep-links and short-links */
  const RE_WA    = /(https?:\/\/)?(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|whatsapp\.com)[^\s]*/gi;

  /* External URLs (anything that isn't mysokoni.co.ke or localhost) */
  const RE_URL   = /https?:\/\/(?!mysokoni\.co\.ke|localhost)[^\s<>"]+/gi;

  /* Trigger phrases that signal intent to share contacts */
  const RE_PHRASE = /\b(my number is|piga simu|namba yangu|namba ni|call me(?: on| at)?|whatsapp me|whatsapp number|wa number|ring me|inbox me|DM me|direct message me|reach me(?: on| at)?|contact me(?: on| at| through)?|find me on|get me on|hit me up|anwani yangu|email me at)\b/gi;

  /* Encoded / spaced-out phone attempts: "0 7 1 2 3 4 5 6 7 8" */
  const RE_SPACED = /\b0\s+[17]\s+(?:[0-9]\s+){7,8}[0-9]\b/g;

  /* Suspicious number-like sequences after trigger words */
  const RE_AFTER_TRIGGER = /(?:namba|number|#)\s*:?\s*([0-9\s\-+]{9,15})/gi;

  /* ──────────────────────────────────────────
     2.  BOOST / PAID-USER CHECK
  ────────────────────────────────────────── */

  function userHasActiveBoom () {
    try {
      const boosts = JSON.parse(localStorage.getItem("sokoniBoosts")) || [];
      const MS_30D = 30 * 24 * 60 * 60 * 1000;
      return boosts.some(b =>
        b.plan !== "basic" &&
        (Date.now() - new Date(b.createdAt).getTime()) < MS_30D
      );
    } catch (e) { return false; }
  }

  /* ──────────────────────────────────────────
     3.  DETECTION — returns array of findings
  ────────────────────────────────────────── */

  function detect (text) {
    const findings = [];
    const resetRegex = r => { r.lastIndex = 0; return r; };

    if (resetRegex(RE_PHONE).test(text))
      findings.push({ type: "phone",   label: "Kenya phone number",      icon: "📱", confidence: 97 });
    if (resetRegex(RE_INTL).test(text))
      findings.push({ type: "intl",    label: "International number",    icon: "☎️", confidence: 92 });
    if (resetRegex(RE_EMAIL).test(text))
      findings.push({ type: "email",   label: "Email address",           icon: "📧", confidence: 98 });
    if (resetRegex(RE_WA).test(text))
      findings.push({ type: "wa",      label: "WhatsApp link",           icon: "💬", confidence: 99 });
    if (resetRegex(RE_URL).test(text))
      findings.push({ type: "url",     label: "External link",           icon: "🔗", confidence: 88 });
    if (resetRegex(RE_PHRASE).test(text))
      findings.push({ type: "phrase",  label: "Contact-sharing phrase",  icon: "⚠️", confidence: 82 });
    if (resetRegex(RE_SPACED).test(text))
      findings.push({ type: "spaced",  label: "Spaced-out phone number", icon: "🔢", confidence: 90 });
    if (resetRegex(RE_AFTER_TRIGGER).test(text))
      findings.push({ type: "trigger", label: "Number after keyword",    icon: "🔍", confidence: 85 });

    return findings;
  }

  function hasContact (text) {
    return detect(text).length > 0;
  }

  /* ──────────────────────────────────────────
     4.  MASKING — hides middle 3 digits
         0712345678  →  0712•••678
         +254712345678 → +254712•••678
  ────────────────────────────────────────── */

  function mask (text) {
    /* Kenya phones: keep prefix+3 digits, hide middle 3, show last 3 */
    text = text.replace(
      /(\+?254|0)([17][0-9]{2})([\s\-]?)([0-9]{3})([\s\-]?)([0-9]{3,4})/g,
      (m, prefix, first3, sp1, mid3, sp2, last) => `${prefix}${first3}•••${last.slice(-3)}`
    );

    /* International numbers */
    text = text.replace(RE_INTL, (m) => {
      const digits = m.replace(/\D/g, "");
      return "+" + digits.slice(0, 3) + "•••" + digits.slice(-4);
    });

    /* Email: j•••@gmail.com */
    text = text.replace(RE_EMAIL, (m) => {
      const [local, domain] = m.split("@");
      return local.charAt(0) + "•••@" + domain;
    });

    /* WhatsApp */
    text = text.replace(RE_WA, "[ 🔒 WhatsApp hidden ]");

    /* External URLs */
    text = text.replace(RE_URL, "[ 🔒 link hidden ]");

    /* Spaced phone */
    text = text.replace(RE_SPACED, "[ 🔒 number hidden ]");

    /* Trigger + number combos */
    text = text.replace(RE_AFTER_TRIGGER, (m, numPart) => {
      const d = numPart.replace(/\D/g, "");
      if (d.length >= 7) {
        const masked = d.slice(0, 3) + "•••" + d.slice(-3);
        return m.replace(numPart, masked);
      }
      return m;
    });

    /* Reset all regex lastIndex */
    [RE_PHONE, RE_INTL, RE_EMAIL, RE_WA, RE_URL, RE_PHRASE, RE_SPACED, RE_AFTER_TRIGGER]
      .forEach(r => { r.lastIndex = 0; });

    return text;
  }

  /* ──────────────────────────────────────────
     5.  PROCESS A MESSAGE
         Returns { text, wasBlocked, findings }
  ────────────────────────────────────────── */

  function process (rawText) {
    const findings = detect(rawText);
    if (findings.length === 0 || userHasActiveBoom()) {
      return { text: rawText, wasBlocked: false, findings: [] };
    }
    return {
      text: mask(rawText),
      wasBlocked: true,
      findings,
    };
  }

  /* ──────────────────────────────────────────
     6.  WARNING MODAL (injected once)
  ────────────────────────────────────────── */

  function _injectStyles () {
    if (document.getElementById("cg-styles")) return;
    const s = document.createElement("style");
    s.id = "cg-styles";
    s.textContent = `
      #cgOverlay{position:fixed;inset:0;background:rgba(0,0,0,0.82);backdrop-filter:blur(12px);z-index:99999;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:20px;animation:cgFadeIn .2s ease;}
      @keyframes cgFadeIn{from{opacity:0}to{opacity:1}}
      #cgBox{background:#141414;border:1px solid rgba(255,60,60,0.25);border-radius:22px;padding:28px;max-width:460px;width:100%;font-family:'Segoe UI',system-ui,sans-serif;margin:auto;}
      #cgBox h2{font-size:17px;font-weight:900;color:white;margin-bottom:6px;display:flex;align-items:center;gap:8px;}
      #cgBox .cg-ai-badge{display:inline-flex;align-items:center;gap:5px;background:rgba(255,60,60,0.12);border:1px solid rgba(255,60,60,0.3);border-radius:6px;padding:3px 9px;font-size:10px;font-weight:800;color:#ff6b6b;flex-shrink:0;}
      .cg-ai-dot{width:6px;height:6px;border-radius:50%;background:#ff6b6b;animation:cgPulse 1.2s infinite;}
      @keyframes cgPulse{0%,100%{opacity:1}50%{opacity:0.3}}
      #cgBox .cg-sub{color:rgba(255,255,255,0.45);font-size:13px;margin-bottom:18px;line-height:1.5;}
      .cg-findings{display:flex;flex-direction:column;gap:6px;margin-bottom:18px;}
      .cg-finding{display:flex;align-items:center;justify-content:space-between;background:rgba(255,60,60,0.06);border:1px solid rgba(255,60,60,0.15);border-radius:10px;padding:9px 12px;}
      .cg-find-left{display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,0.7);}
      .cg-conf{font-size:10px;font-weight:800;color:#ff6b6b;background:rgba(255,60,60,0.12);padding:2px 7px;border-radius:5px;}
      .cg-preview{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:12px;font-size:13px;color:rgba(255,255,255,0.6);line-height:1.6;margin-bottom:18px;word-break:break-word;}
      .cg-preview .cg-mask-tag{background:rgba(255,60,60,0.12);border:1px solid rgba(255,60,60,0.25);border-radius:5px;padding:1px 7px;font-size:11px;color:#ff9999;font-weight:700;}
      .cg-boost-cta{background:linear-gradient(135deg,rgba(249,115,22,0.1),rgba(234,179,8,0.07));border:1px solid rgba(249,115,22,0.25);border-radius:14px;padding:16px;margin-bottom:16px;}
      .cg-boost-cta h4{font-size:13px;font-weight:800;color:white;margin-bottom:4px;}
      .cg-boost-cta p{font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:10px;line-height:1.5;}
      .cg-boost-btn{display:inline-block;padding:9px 20px;background:linear-gradient(135deg,#fb923c,#f97316);color:white;font-weight:800;font-size:13px;border:none;border-radius:10px;cursor:pointer;font-family:inherit;text-decoration:none;}
      .cg-footer{display:flex;gap:8px;flex-wrap:wrap;}
      .cg-btn-send{flex:1;padding:11px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:11px;color:rgba(255,255,255,0.7);font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;}
      .cg-btn-cancel{padding:11px 16px;background:rgba(255,60,60,0.08);border:1px solid rgba(255,60,60,0.2);border-radius:11px;color:#ff6b6b;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;}
    `;
    document.head.appendChild(s);
  }

  /* showWarning — shows the AI analysis modal.
     onSendMasked(maskedText) — callback if user proceeds anyway
     onCancel — callback if user cancels                        */
  function showWarning (rawText, maskedText, findings, onSendMasked, onCancel) {
    _injectStyles();

    /* Remove existing overlay if any */
    const old = document.getElementById("cgOverlay");
    if (old) old.remove();

    const avgConf = Math.round(findings.reduce((a, b) => a + b.confidence, 0) / findings.length);

    const overlay = document.createElement("div");
    overlay.id = "cgOverlay";
    overlay.innerHTML = `
      <div id="cgBox">
        <h2>
          🤖 Contact Guard
          <span class="cg-ai-badge"><span class="cg-ai-dot"></span> AI ACTIVE</span>
        </h2>
        <p class="cg-sub">
          Our AI detected <strong>${findings.length} contact signal${findings.length > 1 ? "s" : ""}</strong>
          in your message. Sharing private contacts outside a paid listing violates Sokoni's fair-use policy
          and disadvantages sellers who invest in their visibility.
        </p>

        <div class="cg-findings">
          ${findings.map(f => `
            <div class="cg-finding">
              <div class="cg-find-left">${f.icon} ${f.label}</div>
              <span class="cg-conf">${f.confidence}% confidence</span>
            </div>
          `).join("")}
        </div>

        <p style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:8px;">
          How your message will appear to the recipient:
        </p>
        <div class="cg-preview">${maskedText.replace(/•••/g, '<span class="cg-mask-tag">•••</span>')}</div>

        <div class="cg-boost-cta">
          <h4>🚀 Unlock Direct Contact Sharing</h4>
          <p>Boost your listing for KES 500/week and share your contacts openly — buyers can reach you directly, building trust faster.</p>
          <a href="marketing.html" class="cg-boost-btn" onclick="document.getElementById('cgOverlay').remove()">
            Boost My Listing →
          </a>
        </div>

        <div class="cg-footer">
          <button class="cg-btn-send" onclick="ContactGuard._sendMasked()">
            Send Anyway (contacts hidden)
          </button>
          <button class="cg-btn-cancel" onclick="ContactGuard._cancel()">
            Edit Message
          </button>
        </div>
      </div>
    `;

    /* Store callbacks on the module for the inline onclick buttons */
    ContactGuard._sendMasked = () => {
      overlay.remove();
      if (onSendMasked) onSendMasked(maskedText);
    };
    ContactGuard._cancel = () => {
      overlay.remove();
      if (onCancel) onCancel();
    };

    document.body.appendChild(overlay);
  }

  /* ──────────────────────────────────────────
     7.  DISPLAY GUARD — sanitise stored text
         for rendering in the UI.
         Always masks on display regardless of
         boost status (for other people's msgs).
  ────────────────────────────────────────── */

  function sanitiseForDisplay (text) {
    /* Don't mask if user has boost — they paid to be contactable */
    if (userHasActiveBoom()) return text;
    if (!hasContact(text)) return text;
    return mask(text);
  }

  /* ──────────────────────────────────────────
     PUBLIC API
  ────────────────────────────────────────── */

  return {
    detect,
    hasContact,
    mask,
    process,
    showWarning,
    sanitiseForDisplay,
    userHasActiveBoom,
    /* private, assigned dynamically by showWarning */
    _sendMasked: null,
    _cancel: null,
  };

})();

/* Make globally available */
window.ContactGuard = ContactGuard;
