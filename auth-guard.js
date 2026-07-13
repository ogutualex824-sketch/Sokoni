/* ================================================================
   SOKONI Auth Guard — auth-guard.js
   Runs synchronously in <head> on every page that has
   data-require-auth="true" on <html>.

   If the user is authenticated (localStorage), page loads normally.
   If not authenticated, an inline sign-in gate overlay is shown on
   top of the page — no redirect to login.html, no page reload.
   Firebase Auth is used directly once the SDK modules load.
================================================================ */
(function () {
  'use strict';
  if (document.documentElement.dataset.requireAuth !== 'true') return;

  var loggedIn = localStorage.getItem('loggedIn') === 'true';
  var hasUser = false;
  try { hasUser = !!JSON.parse(localStorage.getItem('sokoniUser') || 'null'); } catch (e) {}

  /* Already authenticated — show page as normal */
  if (loggedIn && hasUser) return;

  /* ── Inject gate CSS immediately so it's ready when DOM parses ── */
  var css = [
    '#sokoni-auth-gate{',
      'position:fixed;inset:0;z-index:2147483647;',
      'background:#0a0a0a;',
      'display:flex;align-items:center;justify-content:center;padding:24px;',
      'transition:opacity .35s ease;',
    '}',
    '#sokoni-auth-gate.sg-fade{opacity:0;pointer-events:none;}',
    '.sg-card{',
      'width:100%;max-width:380px;',
      'background:#111;border:1px solid rgba(255,255,255,.1);',
      'border-radius:20px;padding:32px 24px;',
      'display:flex;flex-direction:column;gap:14px;',
      'box-shadow:0 24px 80px rgba(0,0,0,.8);',
    '}',
    '.sg-logo{width:72px;margin:0 auto 4px;display:block;}',
    '.sg-title{text-align:center;color:#fff;font-size:20px;font-weight:900;margin:0;}',
    '.sg-sub{text-align:center;color:rgba(255,255,255,.4);font-size:13px;margin:0;}',
    '.sg-msg{font-size:12px;text-align:center;min-height:0;border-radius:8px;',
      'padding:0;max-height:0;overflow:hidden;transition:all .25s ease;',
    '}',
    '.sg-msg.sg-err{background:rgba(255,60,60,.1);color:#ff6b6b;padding:8px 12px;max-height:60px;}',
    '.sg-msg.sg-ok{background:rgba(113,255,0,.1);color:#71ff00;padding:8px 12px;max-height:60px;}',
    '.sg-input{',
      'width:100%;padding:13px 16px;',
      'background:rgba(255,255,255,.06);',
      'border:1.5px solid rgba(255,255,255,.12);border-radius:12px;',
      'color:#fff;font-size:16px;font-family:inherit;',
      'box-sizing:border-box;outline:none;transition:border-color .2s;',
    '}',
    '.sg-input:focus{border-color:rgba(113,255,0,.5);}',
    '.sg-btn{',
      'width:100%;padding:14px;',
      'background:linear-gradient(135deg,#71ff00,#4fc800);',
      'color:#000;font-size:15px;font-weight:900;',
      'border:none;border-radius:14px;cursor:pointer;',
      'font-family:inherit;transition:opacity .2s;',
    '}',
    '.sg-btn:disabled{opacity:.5;cursor:not-allowed;}',
    '.sg-footer{text-align:center;font-size:12px;color:rgba(255,255,255,.35);}',
    '.sg-footer a{color:rgba(113,255,0,.8);text-decoration:none;}',
    '.sg-divider{height:1px;background:rgba(255,255,255,.08);}',
  ].join('');

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  /* ── Build the overlay ── */
  function _buildGate() {
    var gate = document.createElement('div');
    gate.id = 'sokoni-auth-gate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-label', 'Sign in to continue');

    var card = document.createElement('div');
    card.className = 'sg-card';

    /* Logo */
    var logo = document.createElement('img');
    logo.src = 'assets/sokoni logoo.jpeg';
    logo.className = 'sg-logo';
    logo.alt = 'SOKONI';
    logo.onerror = function(){ this.style.display = 'none'; };

    /* Title */
    var title = document.createElement('h2');
    title.className = 'sg-title';
    title.textContent = 'Sign In to Continue';

    var sub = document.createElement('p');
    sub.className = 'sg-sub';
    sub.textContent = 'Enter your SOKONI account details';

    /* Message area */
    var msg = document.createElement('div');
    msg.id = 'sg-msg';
    msg.className = 'sg-msg';

    /* Email */
    var emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.id = 'sg-email';
    emailInput.className = 'sg-input';
    emailInput.placeholder = 'Email address';
    emailInput.autocomplete = 'email';
    emailInput.setAttribute('inputmode', 'email');

    /* Password */
    var passInput = document.createElement('input');
    passInput.type = 'password';
    passInput.id = 'sg-pass';
    passInput.className = 'sg-input';
    passInput.placeholder = 'Password';
    passInput.autocomplete = 'current-password';

    /* Sign-in button */
    var btn = document.createElement('button');
    btn.id = 'sg-btn';
    btn.className = 'sg-btn';
    btn.textContent = 'Sign In';
    btn.onclick = window._sgSubmit;

    /* Divider */
    var divider = document.createElement('div');
    divider.className = 'sg-divider';

    /* Footer */
    var footer = document.createElement('div');
    footer.className = 'sg-footer';
    footer.innerHTML = "New to SOKONI? <a href='signup.html'>Create account</a> &nbsp;·&nbsp; <a href='login.html'>Full login page</a>";

    card.appendChild(logo);
    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(msg);
    card.appendChild(emailInput);
    card.appendChild(passInput);
    card.appendChild(btn);
    card.appendChild(divider);
    card.appendChild(footer);
    gate.appendChild(card);

    /* Enter key submits */
    gate.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') window._sgSubmit();
    });

    document.body.appendChild(gate);

    /* Focus email after a paint cycle */
    setTimeout(function(){ emailInput.focus(); }, 80);
  }

  /* ── Submit handler ── */
  window._sgSubmit = async function() {
    var emailEl = document.getElementById('sg-email');
    var passEl  = document.getElementById('sg-pass');
    var btnEl   = document.getElementById('sg-btn');
    var msgEl   = document.getElementById('sg-msg');

    var email = (emailEl ? emailEl.value : '').trim();
    var pass  = passEl  ? passEl.value  : '';

    function _showMsg(text, type) {
      if (!msgEl) return;
      msgEl.textContent = text;
      msgEl.className = 'sg-msg ' + (type === 'ok' ? 'sg-ok' : 'sg-err');
    }

    if (!email || !pass) {
      _showMsg('Please enter your email and password.', 'err');
      return;
    }

    if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Signing in…'; }
    if (msgEl) { msgEl.className = 'sg-msg'; msgEl.textContent = ''; }

    /* Wait for Firebase Auth to be available (loaded by firebase.js via sokoni-db.js module) */
    var tries = 0;
    while (!window.firebaseAuth && tries < 40) {
      await new Promise(function(r){ setTimeout(r, 150); });
      tries++;
    }

    if (!window.firebaseAuth) {
      /* Firebase unavailable — fall back to login page redirect */
      try {
        sessionStorage.setItem(
          'sokoniLoginRedirect',
          window.location.pathname.split('/').pop() + (window.location.search || '')
        );
      } catch(e) {}
      window.location.href = 'login.html';
      return;
    }

    try {
      var { signInWithEmailAndPassword } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'
      );
      await signInWithEmailAndPassword(window.firebaseAuth, email, pass);

      /* firebase.js onAuthStateChanged will sync localStorage, but set loggedIn now
         so pages that check it synchronously see it immediately */
      localStorage.setItem('loggedIn', 'true');

      _showMsg('Welcome back! Opening…', 'ok');

      /* Fade gate out and reveal the page */
      setTimeout(function() {
        var gate = document.getElementById('sokoni-auth-gate');
        if (gate) {
          gate.classList.add('sg-fade');
          setTimeout(function(){ if (gate.parentNode) gate.parentNode.removeChild(gate); }, 380);
        }
      }, 500);

    } catch(err) {
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Sign In'; }
      var code = err && err.code;
      var errMsg = 'Wrong email or password. Try again.';
      if (code === 'auth/too-many-requests')       errMsg = 'Too many attempts. Try again later.';
      if (code === 'auth/network-request-failed')  errMsg = 'Connection error. Check your internet.';
      if (code === 'auth/user-disabled')           errMsg = 'Account disabled. Contact support.';
      if (code === 'auth/invalid-email')           errMsg = 'Invalid email address.';
      _showMsg(errMsg, 'err');
    }
  };

  /* ── Inject gate after body is available ── */
  if (document.body) {
    _buildGate();
  } else {
    document.addEventListener('DOMContentLoaded', _buildGate);
  }
})();
