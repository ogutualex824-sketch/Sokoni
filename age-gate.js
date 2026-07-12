/**
 * SOKONI Age Gate — blocks access for users under 18
 * Runs on every page. Once verified, stores a 30-day pass in localStorage.
 * DOB is never sent anywhere — checked client-side only.
 */
(function () {
  'use strict';

  var STORE_KEY  = 'sokoniAgeGate';
  var PASS_DAYS  = 30;

  /* ── 1. Already verified? Skip everything ── */
  function _isVerified() {
    try {
      var d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!d || !d.v) return false;
      return (Date.now() - d.ts) < PASS_DAYS * 86400000;
    } catch (e) { return false; }
  }
  if (_isVerified()) return;

  /* ── 2. Build year options (current year − 100 → current year − 1) ── */
  var NOW = new Date();
  var CUR_YEAR = NOW.getFullYear();

  function _yearOpts() {
    var html = '<option value="">Year</option>';
    for (var y = CUR_YEAR - 1; y >= CUR_YEAR - 100; y--) {
      html += '<option value="' + y + '">' + y + '</option>';
    }
    return html;
  }

  var MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
  function _monthOpts() {
    var html = '<option value="">Month</option>';
    MONTHS.forEach(function (m, i) {
      html += '<option value="' + (i + 1) + '">' + m + '</option>';
    });
    return html;
  }

  function _dayOpts() {
    var html = '<option value="">Day</option>';
    for (var d = 1; d <= 31; d++) {
      html += '<option value="' + d + '">' + d + '</option>';
    }
    return html;
  }

  /* ── 3. Inject styles ── */
  var css = [
    '#sk-age-gate{position:fixed;inset:0;z-index:2147483647;background:radial-gradient(ellipse at 50% 30%,#0f1f00 0%,#050505 70%);display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px;font-family:"Segoe UI",system-ui,sans-serif;}',
    '#sk-age-box{max-width:420px;width:100%;text-align:center;margin:auto;}',
    '#sk-age-logo{height:40px;margin-bottom:28px;}',
    '#sk-age-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.3);border-radius:999px;padding:5px 16px;font-size:11px;font-weight:800;color:#71ff00;text-transform:uppercase;letter-spacing:.07em;margin-bottom:18px;}',
    '#sk-age-title{font-size:clamp(22px,5vw,32px);font-weight:900;color:white;margin-bottom:8px;line-height:1.15;}',
    '#sk-age-sub{font-size:13px;color:rgba(255,255,255,0.45);margin-bottom:28px;line-height:1.6;}',
    '.sk-dob-row{display:grid;grid-template-columns:1fr 2fr 1.4fr;gap:8px;margin-bottom:14px;}',
    '.sk-dob-sel{padding:13px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:12px;color:white;font-size:13px;font-family:inherit;outline:none;appearance:none;cursor:pointer;transition:border-color .2s;width:100%;}',
    '.sk-dob-sel:focus{border-color:rgba(113,255,0,0.5);}',
    '.sk-dob-sel option{background:#111;color:white;}',
    '#sk-age-err{font-size:12px;color:#ff6b6b;min-height:18px;margin-bottom:10px;font-weight:700;}',
    '#sk-age-btn{width:100%;padding:15px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-weight:900;font-size:15px;border:none;border-radius:13px;cursor:pointer;font-family:inherit;transition:filter .2s;margin-bottom:16px;}',
    '#sk-age-btn:hover{filter:brightness(1.08);}',
    '#sk-age-note{font-size:10px;color:rgba(255,255,255,0.2);line-height:1.6;}',
    '#sk-age-note a{color:rgba(113,255,0,0.5);text-decoration:none;}',
    /* Sorry screen */
    '#sk-sorry{display:none;text-align:center;}',
    '#sk-sorry-icon{font-size:64px;margin-bottom:16px;}',
    '#sk-sorry-title{font-size:24px;font-weight:900;color:white;margin-bottom:8px;}',
    '#sk-sorry-sub{font-size:13px;color:rgba(255,255,255,0.4);line-height:1.7;max-width:320px;margin:0 auto;}',
  ].join('');

  var styleEl = document.createElement('style');
  styleEl.id  = 'sk-age-style';
  styleEl.textContent = css;
  (document.head || document.documentElement).appendChild(styleEl);

  /* ── 4. Build HTML ── */
  var html = [
    '<div id="sk-age-gate">',
      '<div id="sk-age-box">',

        /* ── Verify screen ── */
        '<div id="sk-verify">',
          '<img id="sk-age-logo" src="assets/Sokoni Logo.png" alt="SOKONI">',
          '<div id="sk-age-badge">🔒 Age Verification</div>',
          '<div id="sk-age-title">You must be<br><span style="background:linear-gradient(135deg,#71ff00,#4fc800);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">18 or older</span><br>to use SOKONI</div>',
          '<div id="sk-age-sub">SOKONI connects buyers, sellers, service providers and financial institutions across Kenya. This platform is for adults only.</div>',
          '<div class="sk-dob-row">',
            '<select class="sk-dob-sel" id="sk-day">' + _dayOpts() + '</select>',
            '<select class="sk-dob-sel" id="sk-month">' + _monthOpts() + '</select>',
            '<select class="sk-dob-sel" id="sk-year">' + _yearOpts() + '</select>',
          '</div>',
          '<div id="sk-age-err"></div>',
          '<button id="sk-age-btn" onclick="skAgeVerify()">Confirm My Age →</button>',
          '<div id="sk-age-note">',
            'Your date of birth is verified locally and never stored on our servers.<br>',
            'By continuing you agree to our <a href="legal.html">Terms</a> and confirm you are 18+.',
          '</div>',
        '</div>',

        /* ── Sorry screen ── */
        '<div id="sk-sorry">',
          '<div id="sk-sorry-icon">🚫</div>',
          '<div id="sk-sorry-title">Access Denied</div>',
          '<div id="sk-sorry-sub">',
            'Sorry — SOKONI is only available to users who are <strong style="color:#ff6b6b;">18 years or older.</strong><br><br>',
            'Come back when you\'re of age. We\'ll be here! 👋',
          '</div>',
          '<div style="margin-top:28px;font-size:11px;color:rgba(255,255,255,0.15);">' +
            (((typeof window !== 'undefined' && window.SOKONI_COMPANY && window.SOKONI_COMPANY.footerCopyright)) ||
             '&copy; 2026 SOKONI · A product of Bravilex International Co. Limited') +
          '</div>',
        '</div>',

      '</div>',
    '</div>',
  ].join('');

  /* ── 5. Mount gate ── */
  function _mount() {
    document.documentElement.style.overflow = 'hidden';
    var wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper.firstChild);
  }

  if (document.body) {
    _mount();
  } else {
    document.addEventListener('DOMContentLoaded', _mount);
  }

  /* ── 6. Verify logic (exposed globally) ── */
  window.skAgeVerify = function () {
    var day   = parseInt(document.getElementById('sk-day').value,   10);
    var month = parseInt(document.getElementById('sk-month').value, 10);
    var year  = parseInt(document.getElementById('sk-year').value,  10);
    var errEl = document.getElementById('sk-age-err');

    if (!day || !month || !year) {
      errEl.textContent = '⚠️ Please select your full date of birth.';
      return;
    }

    /* Calculate exact age */
    var dob = new Date(year, month - 1, day);
    var today = new Date();
    var age = today.getFullYear() - dob.getFullYear();
    var mDiff = today.getMonth() - dob.getMonth();
    if (mDiff < 0 || (mDiff === 0 && today.getDate() < dob.getDate())) age--;

    /* Sanity check — reject impossible dates */
    if (dob > today || year < CUR_YEAR - 120) {
      errEl.textContent = '⚠️ Please enter a valid date of birth.';
      return;
    }

    if (age < 18) {
      /* Show sorry screen */
      document.getElementById('sk-verify').style.display = 'none';
      document.getElementById('sk-sorry').style.display  = 'block';
      /* Store a short-lived rejection so they can't just refresh */
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ v: false, ts: Date.now() })); } catch(e) {}
      return;
    }

    /* ✅ 18+ — grant 30-day pass */
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ v: true, ts: Date.now() })); } catch(e) {}
    var gate = document.getElementById('sk-age-gate');
    if (gate) {
      gate.style.transition = 'opacity 0.5s ease';
      gate.style.opacity    = '0';
      setTimeout(function () {
        gate.remove();
        document.documentElement.style.overflow = '';
      }, 520);
    }
  };

  /* Allow Enter key on the selects */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && document.getElementById('sk-age-gate')) {
      window.skAgeVerify();
    }
  });

})();
