/* ================================================================
   SOKONI — Authentication  (non-module; uses window.firebaseAuth
   and window.firebaseDB exposed by the firebase.js module)

   Functions are global so onclick= handlers in login.html and
   signup.html can call them directly.
================================================================ */

/* ── On load: capture ?next= or ?redirect= URL param into sessionStorage ── */
(function(){
    try {
        const sp = new URLSearchParams(window.location.search);
        const next = sp.get('next') || sp.get('redirect');
        if (next && /^[a-zA-Z0-9_\-\.\/\?=&%#]+$/.test(next) && !next.includes('//')) {
            sessionStorage.setItem('sokoniLoginRedirect', next);
        }
    } catch(e) {}
})();

/* ── Session inactivity auto-logout ───────────────────────────────────────
   Regular users: 60 min idle → auto sign-out.
   Admin / SuperAdmin: 20 min idle → auto sign-out (tighter window for
   high-privilege sessions). The timer resets on any user interaction.
─────────────────────────────────────────────────────────────────────────── */
(function(){
    const IDLE_MS_USER  = 60 * 60 * 1000;  // 60 min
    const IDLE_MS_ADMIN = 20 * 60 * 1000;  // 20 min
    let _idleTimer = null;

    function _getIdleLimit(){
        try {
            const u = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
            if(!u) return IDLE_MS_USER;
            const roles = u.roles || [];
            const role  = u.role  || '';
            const isAdmin = roles.includes('admin') || roles.includes('superAdmin') ||
                            role === 'admin' || role === 'superAdmin';
            return isAdmin ? IDLE_MS_ADMIN : IDLE_MS_USER;
        } catch(e){ return IDLE_MS_USER; }
    }

    async function _signOutNow(){
        try {
            localStorage.removeItem('sokoniUser');
            localStorage.removeItem('loggedIn');
            if(window.firebaseAuth){
                const { signOut } = await import(
                    'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'
                );
                await signOut(window.firebaseAuth);
            }
        } catch(e){}
        window.location.href = 'login.html?reason=idle';
    }

    function _resetIdleTimer(){
        clearTimeout(_idleTimer);
        _idleTimer = setTimeout(_signOutNow, _getIdleLimit());
    }

    ['click','keydown','mousemove','touchstart','scroll'].forEach(function(ev){
        document.addEventListener(ev, _resetIdleTimer, { passive: true });
    });

    /* Only start timer once user is actually logged in */
    document.addEventListener('DOMContentLoaded', function(){
        if(localStorage.getItem('loggedIn') === 'true') _resetIdleTimer();
    });

    /* Re-arm when user logs in (SokoniSecurity.setSession calls this) */
    window._armIdleTimer = _resetIdleTimer;
})();

/* ── UI helpers ── */
function showAuthMsg(msg, type){
    const el = document.getElementById("authMsg");
    if(!el) return;
    el.textContent = msg;
    el.className = "auth-msg " + type;
}

function _highlightDob(on){
    ['dobDay','dobMonth','dobYear'].forEach(id=>{
        const el = document.getElementById(id);
        if(el) el.style.borderColor = on ? 'rgba(255,107,107,0.7)' : 'rgba(255,255,255,0.12)';
    });
}

/* Map Firebase Auth error codes to user-friendly messages */
function _fbErr(code){
    switch(code){
        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
        case 'auth/invalid-login-credentials':
            return 'Wrong email or password. Try again.';
        case 'auth/email-already-in-use':
            return 'An account with this email already exists. Sign in instead.';
        case 'auth/weak-password':
            return 'Password must be at least 8 characters.';
        case 'auth/invalid-email':
            return 'Please enter a valid email address.';
        case 'auth/too-many-requests':
            return 'Too many attempts. Account temporarily locked. Try again later.';
        case 'auth/network-request-failed':
            return 'Connection error. Please check your internet connection.';
        case 'auth/user-disabled':
            return 'This account has been disabled. Contact support.';
        default:
            return 'Something went wrong. Please try again.';
    }
}

/* ══════════════════════════════════════════════════════════════
   LOGIN
══════════════════════════════════════════════════════════════ */
async function loginUser(){
    const email    = (document.getElementById("loginEmail")?.value    || "").trim().toLowerCase();
    const password = (document.getElementById("loginPassword")?.value || "");

    if(!email || !password){
        showAuthMsg("Please fill all fields.", "error");
        return;
    }

    /* Persistent rate limit: max 10 attempts per minute */
    if(typeof SokoniSecurity !== 'undefined' && SokoniSecurity.persistentRateLimit){
        if(!SokoniSecurity.persistentRateLimit('login_' + email, 10, 60000)){
            showAuthMsg("Too many requests. Please wait a moment.", "error");
            return;
        }
    }

    /* Account lockout — blocks after 5 consecutive failures for 15 min */
    if(typeof SokoniSecurity !== 'undefined' && SokoniSecurity.isLoginLocked){
        const lockStatus = SokoniSecurity.isLoginLocked(email);
        if(lockStatus && lockStatus.locked){
            showAuthMsg(
                "Account locked after too many failed attempts. Try again in " +
                lockStatus.minsLeft + " minute" + (lockStatus.minsLeft !== 1 ? "s" : "") + ".",
                "error"
            );
            return;
        }
    }

    const btn = document.querySelector(".auth-btn[onclick*='loginUser']") || document.querySelector(".auth-btn");
    if(btn){ btn.disabled = true; btn.textContent = "Signing in…"; }

    /* Apply Remember Me persistence before Firebase call */
    await _setPersistenceFromUI();

    try {
        /* ── Firebase Authentication ── */
        const { signInWithEmailAndPassword } = await import(
            "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"
        );

        if(!window.firebaseAuth){
            throw new Error("Firebase not ready. Please refresh the page.");
        }

        const cred = await signInWithEmailAndPassword(window.firebaseAuth, email, password);

        /* Fetch full profile from Firestore users collection */
        let profile = {
            uid:   cred.user.uid,
            name:  cred.user.displayName || email.split('@')[0],
            email: email,
            registeredAs: { buyer: true }
        };

        try {
            const { getDoc, doc } = await import(
                "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
            );
            const snap = await getDoc(doc(window.firebaseDB, 'users', cred.user.uid));
            if(snap.exists()) profile = snap.data();
        } catch(fsErr){
            /* Non-fatal — continue with basic profile if Firestore unreachable */
        }

        /* ── Sync to localStorage for backward-compat with all other pages ── */
        localStorage.setItem("sokoniUser", JSON.stringify(profile));
        localStorage.setItem("loggedIn", "true");
        localStorage.removeItem("sokoniCreds"); /* clear legacy SHA-256 creds */

        /* ── SokoniSecurity session ── */
        if(typeof SokoniSecurity !== 'undefined'){
            SokoniSecurity.setSession && SokoniSecurity.setSession(profile);
            SokoniSecurity.clearLoginLockout && SokoniSecurity.clearLoginLockout(email);
            SokoniSecurity.migrateUserData && SokoniSecurity.migrateUserData([
                'sellerProducts','sellerOrders','sokoniOrders','sokoniCart',
                'sokoniWishlist','sokoniMessages','sokoniBookings','sokoniTeams',
                'sokoniBroadcasts','sokoniBnbBookings',
            ]);
        }

        /* ── SokoniSync: restore cross-device data ── */
        if(window.SokoniSync){
            window.SokoniSync.init(window.firebaseDB, cred.user.uid);
            window.SokoniSync.pull(cred.user.uid);
        } else {
            window._sokoniSyncPending = { db: window.firebaseDB, uid: cred.user.uid };
        }

        if(typeof sokoniTrackLogin === "function") sokoniTrackLogin();
        if(window.SokoniSessions?.createSession){
            window.SokoniSessions.createSession(email).catch(()=>{});
        }
        if(typeof SokoniAudit !== 'undefined')
            SokoniAudit.log(SokoniAudit.ACTIONS.LOGIN_SUCCESS, { email, role: profile.role || 'buyer' });

        /* ── Google account linking ──
           If the user arrived here because Google found their email already
           registered with a password, link the Google credential now so both
           providers work on the same account going forward.             */
        if (window._pendingGoogleLink) {
            try {
                const { GoogleAuthProvider, linkWithCredential } = await import(
                    'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'
                );
                const pendingCred = GoogleAuthProvider.credentialFromError(
                    window._pendingGoogleLink.error
                );
                if (pendingCred) {
                    await linkWithCredential(cred.user, pendingCred);
                    /* Record the new provider in Firestore (merge-safe) */
                    try {
                        const { doc, setDoc, serverTimestamp: _sts } = await import(
                            'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
                        );
                        await setDoc(
                            doc(window.firebaseDB, 'users', cred.user.uid),
                            { googleLinked: true, googleLinkedAt: _sts() },
                            { merge: true }
                        );
                    } catch (_) { /* non-fatal */ }
                    if (typeof SokoniAudit !== 'undefined') {
                        SokoniAudit.log('GOOGLE_ACCOUNT_LINKED', { email });
                    }
                }
                window._pendingGoogleLink = null;
            } catch (linkErr) {
                /* Non-fatal — user is still signed in with password */
                window._pendingGoogleLink = null;
            }
        }

        /* ── Non-Google OAuth provider linking ── */
        await _linkPendingProvider(cred.user, email);

        /* ── Employee account detection ── */
        if(profile.role === "employee" && profile.shopOwnerId){
            localStorage.setItem("sokoniEmployeeSession", JSON.stringify({
                uid: profile.uid,
                name: profile.name,
                email: profile.email,
                employeeRole: profile.employeeRole,
                shopOwnerId: profile.shopOwnerId,
                shopName: profile.shopName || "My Shop",
                isEmployee: true
            }));
            if(typeof SokoniAudit !== 'undefined')
                SokoniAudit.log(SokoniAudit.ACTIONS.EMPLOYEE_LOGIN, { email, shopName: profile.shopName, employeeRole: profile.employeeRole });
            showAuthMsg(`Welcome ${profile.name}! Loading your store dashboard...`, "success");
            setTimeout(() => window.location.href = "seller.html?employee=1", 1200);
            return;
        }

        showAuthMsg("Login successful! Taking you home...", "success");

        /* ── Fire login-alert email (new device detection) ── */
        (async () => {
            try {
                const { getFunctions, httpsCallable } = await import(
                    "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js"
                );
                const fns  = getFunctions(window.firebaseApp, "us-central1");
                const call = httpsCallable(fns, "onLoginEvent");
                /* Simple device fingerprint: hash of UA + screen dims */
                const raw  = [navigator.userAgent, screen.width, screen.height, navigator.language].join("|");
                let fp = 0;
                for (let i = 0; i < raw.length; i++) fp = (Math.imul(31, fp) + raw.charCodeAt(i)) >>> 0;
                await call({
                    device:      navigator.userAgent,
                    userAgent:   navigator.userAgent,
                    fingerprint: String(fp),
                    location:    "Kenya",
                    ip:          "",
                });
            } catch (_) { /* non-fatal — never block login */ }
        })();

        const _rawRedir = sessionStorage.getItem("sokoniLoginRedirect") || "index.html";
        sessionStorage.removeItem("sokoniLoginRedirect");
        /* Validate redirect — only allow same-origin relative paths, block open-redirect */
        const _safeRedir = /^[a-zA-Z0-9_\-\.\/\?=&%#]+$/.test(_rawRedir) && !_rawRedir.includes('//') ? _rawRedir : "index.html";
        setTimeout(() => window.location.href = _safeRedir, 1200);

    } catch(err){
        if(btn){ btn.disabled = false; btn.textContent = "Sign In →"; }

        if(typeof SokoniSecurity !== 'undefined'){
            SokoniSecurity.audit && SokoniSecurity.audit('LOGIN_FAILED', { email, reason: err.code || err.message });
            SokoniSecurity.recordFailedLogin && SokoniSecurity.recordFailedLogin(email);
        }
        if(typeof SokoniAudit !== 'undefined')
            SokoniAudit.log(SokoniAudit.ACTIONS.LOGIN_FAIL, { email, errorCode: err.code || 'unknown' });

        /* Guide legacy localStorage-only accounts to the migration path */
        if(err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' ||
           err.code === 'auth/invalid-login-credentials'){
            const oldCreds = JSON.parse(localStorage.getItem("sokoniCreds") || 'null');
            if(oldCreds && (oldCreds.email || "").toLowerCase() === email){
                showAuthMsg(
                    "Your account needs a one-time security upgrade. " +
                    "Use 'Forgot Password' to receive a reset email and set a new password.",
                    "error"
                );
                return;
            }

            /* Demo / test account fallback removed — all logins require Firebase Auth */
        }

        showAuthMsg(_fbErr(err.code), "error");
    }
}

/* ══════════════════════════════════════════════════════════════
   SIGNUP  (public entry point — wraps _doSignup with top-level
   error boundary so the catch in signupUser always runs)
══════════════════════════════════════════════════════════════ */
async function signupUser(){
    try {
        const name     = (document.getElementById("signupName")?.value     || "").trim();
        const email    = (document.getElementById("signupEmail")?.value    || "").trim();
        const password = (document.getElementById("signupPassword")?.value || "");
        await _doSignup(name, email, password);
    } catch(err){
        showAuthMsg("Error: " + (err.message || "Something went wrong. Please try again."), "error");
        const btn = document.getElementById("createAccBtn");
        if(btn){ btn.disabled = false; btn.textContent = "Create Account →"; }
    }
}

async function _doSignup(name, email, password){
    const btn = document.getElementById("createAccBtn");
    if(btn){ btn.disabled = true; btn.textContent = "Creating account…"; }

    function fail(msg){ showAuthMsg(msg, "error"); if(btn){ btn.disabled = false; btn.textContent = "Create Account →"; } }

    if(!name || !email || !password){
        fail("Please fill all fields."); return;
    }

    /* Password strength */
    if(typeof SokoniSecurity !== 'undefined' && SokoniSecurity.validatePassword){
        const pwCheck = SokoniSecurity.validatePassword(password);
        if(!pwCheck.ok){ fail(pwCheck.msg); return; }
    } else if(password.length < 8){
        fail("Password must be at least 8 characters."); return;
    }

    /* Age verification — must be 18+ */
    const dobVal = (document.getElementById("dobDate")?.value || "").trim();
    if(!dobVal){ fail("Please enter your date of birth."); return; }
    const dob   = new Date(dobVal + "T00:00:00");
    const today = new Date();
    if(isNaN(dob.getTime())){ fail("Please enter a valid date of birth."); return; }
    let age = today.getFullYear() - dob.getFullYear();
    const mDiff = today.getMonth() - dob.getMonth();
    if(mDiff < 0 || (mDiff === 0 && today.getDate() < dob.getDate())) age--;
    if(dob.getFullYear() < today.getFullYear() - 120){ fail("Please enter a valid date of birth."); return; }
    if(age < 18){ fail("You must be 18 or older to create a SOKONI account."); return; }
    const dobYear  = dob.getFullYear();
    const dobMonth = dob.getMonth() + 1;
    const dobDay   = dob.getDate();

    /* Privacy Policy consent */
    const consentBox = document.getElementById("privacyConsent");
    if(consentBox && !consentBox.checked){
        if(consentBox.closest('div')) consentBox.closest('div').style.borderColor = 'rgba(255,107,107,0.6)';
        fail("Please agree to the Privacy Policy to continue."); return;
    }

    if(!window.firebaseAuth || !window.firebaseDB){
        fail("Firebase not ready. Please refresh the page."); return;
    }

    try {
        const { createUserWithEmailAndPassword, updateProfile, sendEmailVerification } = await import(
            "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"
        );
        const { doc, setDoc, serverTimestamp } = await import(
            "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
        );

        /* Create Firebase Auth account */
        const cred = await createUserWithEmailAndPassword(window.firebaseAuth, email, password);
        await updateProfile(cred.user, { displayName: name });
        /* Send email verification — non-blocking; failure does not abort signup */
        sendEmailVerification(cred.user).catch(function(){});

        /* Build the profile object stored in both Firestore and localStorage */
        const dobStr = `${dobYear}-${String(dobMonth).padStart(2,'0')}-${String(dobDay).padStart(2,'0')}`;
        const _now = new Date();
        const profile = {
            uid:              cred.user.uid,
            name,
            email,
            dob:              dobStr,
            ageVerified:      true,
            joinedAt:         _now.toLocaleDateString("en-KE",{day:"numeric",month:"short",year:"numeric"}),
            joinedTimestamp:  _now.getTime(),
            registeredAs:     { user: true },
            roles:            ['user'],
            role:             'user',
        };

        /* Persist to Firestore users collection (the authoritative source) */
        await setDoc(doc(window.firebaseDB, 'users', cred.user.uid), {
            ...profile,
            createdAt: serverTimestamp()
        });

        /* Sync to localStorage for backward-compat */
        localStorage.setItem("sokoniUser", JSON.stringify(profile));
        localStorage.setItem("loggedIn", "true");
        localStorage.removeItem("sokoniCreds");

        if(typeof SokoniSecurity !== 'undefined'){
            SokoniSecurity.setSession && SokoniSecurity.setSession(profile);
            SokoniSecurity.audit && SokoniSecurity.audit('SIGNUP', { name, email });
        }
        if(typeof SokoniAudit !== 'undefined')
            SokoniAudit.log(SokoniAudit.ACTIONS.SIGNUP, { name, email });

        /* Auto welcome message */
        let msgs = [];
        try { msgs = JSON.parse(localStorage.getItem("sokoniMessages")) || []; } catch(e) {}
        msgs.unshift({
            id: "conv_welcome",
            productName: "Welcome to SOKONI! 🎉",
            sellerName: "Sokoni Team",
            messages: [
                { sender:"seller", text:`Hi ${name}! 👋 Welcome to SOKONI — Kenya's global marketplace! We're excited to have you.\n\n✅ Your account is ready\n⭐ Earn points on every purchase\n📦 Track orders in real-time\n💬 Chat with sellers directly\n\nHappy shopping! 🛍️`, time: new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}) }
            ],
            unread: 1, spam: false, createdAt: Date.now()
        });
        localStorage.setItem("sokoniMessages", JSON.stringify(msgs));

        /* ── SokoniSync: init for new account (nothing to pull yet) ── */
        if(window.SokoniSync){
            window.SokoniSync.init(window.firebaseDB, cred.user.uid);
        } else {
            window._sokoniSyncPending = { db: window.firebaseDB, uid: cred.user.uid };
        }

        if(typeof sokoniTrackSignup === "function") sokoniTrackSignup();

        /* ── Replace the auth card with the success screen ── */
        const card = document.querySelector(".auth-card");
        if(card){
            /* name is user-supplied — set via textContent after building the scaffold */
            const _safeName = document.createTextNode(name);
            card.innerHTML = `
              <div style="text-align:center;padding:20px 10px;">
                <div style="font-size:64px;margin-bottom:16px;">&#127881;</div>
                <h2 style="font-size:22px;font-weight:900;color:white;margin-bottom:8px;">Account Created!</h2>
                <p style="font-size:14px;color:rgba(255,255,255,0.55);margin-bottom:28px;line-height:1.6;">
                  Welcome to SOKONI, <strong id="_authSuccessName" style="color:#71ff00;"></strong>!<br>
                  You're all set &mdash; let&#x27;s get started.
                </p>
                <button type="button" onclick="window.location.href='index.html'"
                  style="width:100%;padding:15px;background:linear-gradient(135deg,#71ff00,#4fc800);color:black;font-weight:900;font-size:16px;border:none;border-radius:14px;cursor:pointer;font-family:inherit;margin-bottom:12px;letter-spacing:.01em;">
                  🛍️ Go to Marketplace
                </button>
                <button type="button" onclick="window.location.href='seller.html'"
                  style="width:100%;padding:14px;background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.25);color:#71ff00;font-weight:800;font-size:14px;border-radius:14px;cursor:pointer;font-family:inherit;margin-bottom:12px;">
                  🏪 Open Seller Dashboard
                </button>
                <button type="button" onclick="window.location.href='login.html'"
                  style="width:100%;padding:12px;background:transparent;border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.45);font-weight:700;font-size:13px;border-radius:12px;cursor:pointer;font-family:inherit;">
                  🔑 Sign In Instead
                </button>
                <p style="margin-top:18px;font-size:11px;color:rgba(255,255,255,0.25);">
                  You can set your roles anytime from Profile → My Roles
                </p>
              </div>`;
            /* Safely inject name — avoids XSS via innerHTML interpolation */
            const nameEl = card.querySelector('#_authSuccessName');
            if(nameEl) nameEl.textContent = name;
            window.scrollTo(0,0);
            card.scrollIntoView({behavior:'smooth', block:'start'});
        } else {
            showAuthMsg("Account created! Redirecting...", "success");
            setTimeout(() => window.location.href = "index.html", 1500);
        }

    } catch(err){
        fail(_fbErr(err.code));
        throw err;
    }
}

/* ══════════════════════════════════════════════════════════════
   ROLE SELECTION  (shown after signup on signup.html)
══════════════════════════════════════════════════════════════ */
function updateRoleSelection(){
    /* Visual feedback hook — extend if needed */
}

async function completeRoleSelection(){
    let user;
    try { user = JSON.parse(localStorage.getItem("sokoniUser")); }
    catch(e){ user = null; }

    if(!user){
        showAuthMsg("Error: User not found.", "error");
        return;
    }

    const cb = id => { const el = document.getElementById(id); return el && el.checked; };

    if(cb("roleSellerCb"))     user.registeredAs.seller      = true;
    if(cb("roleHealthcareCb")) user.registeredAs.healthcare   = true;
    if(cb("roleDriverCb"))     user.registeredAs.driver       = true;
    if(cb("roleDeliveryCb"))   user.registeredAs.delivery     = true;
    if(cb("roleLandlordCb"))   user.registeredAs.landlord     = true;
    if(cb("roleLegalCb"))      user.registeredAs.legal        = true;

    localStorage.setItem("sokoniUser", JSON.stringify(user));

    /* Also persist roles to Firestore when a Firebase session is active */
    try {
        if(window.firebaseAuth?.currentUser && window.firebaseDB){
            const { doc, updateDoc } = await import(
                "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
            );
            await updateDoc(
                doc(window.firebaseDB, 'users', window.firebaseAuth.currentUser.uid),
                { registeredAs: user.registeredAs }
            );
        }
    } catch(e){
        /* localStorage already updated — Firestore sync is best-effort */
    }

    let dest = "index.html";
    let label = "Taking you to the marketplace…";
    if(user.registeredAs.seller){
        dest  = "seller.html";
        label = "Opening your Seller Dashboard…";
    } else if(user.registeredAs.driver){
        dest  = "driver.html";
        label = "Opening Driver Dashboard…";
    } else if(user.registeredAs.delivery){
        dest  = "onboarding-driver.html";
        label = "Setting up your Delivery Profile…";
    } else if(user.registeredAs.healthcare){
        dest  = "healthcare.html";
        label = "Opening Healthcare Hub…";
    } else if(user.registeredAs.legal){
        dest  = "provider.html?cat=legal";
        label = "Opening Legal Services Dashboard…";
    } else if(user.registeredAs.landlord){
        dest  = "landlord.html";
        label = "Opening Property Dashboard…";
    }

    if(typeof sokoniTrackSignup === "function") sokoniTrackSignup();
    showAuthMsg("Welcome to SOKONI! " + label, "success");

    const btn = document.querySelector("#roleSelectionSection .auth-btn");
    if(btn){ btn.disabled = true; btn.textContent = label; }

    setTimeout(() => window.location.href = dest, 1400);
}

/* ══════════════════════════════════════════════════════════════
   PASSWORD RESET
   Firebase Auth sends a secure email link — no client-side
   token or DOB check needed.
══════════════════════════════════════════════════════════════ */
async function requestPasswordReset(){
    const email = (document.getElementById("resetEmail")?.value || "").trim().toLowerCase();

    if(!email){
        showAuthMsg("Please enter your email address.", "error");
        return;
    }

    /* Rate limit: 3 reset attempts per 15 minutes per email */
    if(typeof SokoniSecurity !== 'undefined' && SokoniSecurity.persistentRateLimit){
        if(!SokoniSecurity.persistentRateLimit('pw_reset_' + email, 3, 900000)){
            showAuthMsg("Too many reset attempts. Try again in 15 minutes.", "error");
            return;
        }
    }

    try {
        const { sendPasswordResetEmail } = await import(
            "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"
        );
        if(window.firebaseAuth){
            await sendPasswordResetEmail(window.firebaseAuth, email);
        }
    } catch(e){
        /* Always show the same message — never confirm whether the email exists */
    }

    if(typeof SokoniSecurity !== 'undefined'){
        SokoniSecurity.audit && SokoniSecurity.audit('PASSWORD_RESET_REQUEST', { email });
    }

    /* Replace Step 1 content with a confirmation message */
    const step1 = document.getElementById("resetStep1");
    if(step1){
        step1.innerHTML = `
            <div style="text-align:center;padding:10px 0;">
                <div style="font-size:40px;margin-bottom:12px;">&#128231;</div>
                <p style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.7;">
                    If <strong id="_resetEmailDisplay" style="color:#71ff00;"></strong> is registered,<br>
                    a password reset link has been sent.<br><br>
                    <span style="font-size:12px;color:rgba(255,255,255,0.4);">
                        Click the link in your email to set a new password.<br>
                        Check your spam folder if it doesn&#x27;t arrive.
                    </span>
                </p>
            </div>`;
        const _resetEl = step1.querySelector('#_resetEmailDisplay');
        if(_resetEl) _resetEl.textContent = email;
    }
    /* Hide step 2 — it is no longer needed with email-link reset */
    const step2 = document.getElementById("resetStep2");
    if(step2) step2.style.display = "none";
}

/* Stub — Firebase handles password setting on its hosted reset page */
async function completePasswordReset(){
    showAuthMsg("Please use the reset link in your email to set a new password.", "info");
}

/* ══════════════════════════════════════════════════════════════
   GOOGLE OAUTH
   Supports:
   • Desktop  → signInWithPopup
   • Popup blocked → falls back to signInWithRedirect automatically
   • Installed PWA / iOS Safari → signInWithRedirect from the start
   • Account linking → if email already exists with password, links
     Google after the user re-authenticates with their password
══════════════════════════════════════════════════════════════ */

/* Detect whether popup-based OAuth is reliable.
   Installed PWAs (standalone display-mode) open auth popups in the
   system browser — the result never returns to the app context.
   iOS Safari (any mode) also has popup reliability issues. */
function _isPopupSupported() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                      || window.navigator.standalone === true;
    if (isStandalone) return false;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    return !isIOS;
}

/* Safely update the text span inside the Google button */
function _googleBtnLabel(btn, text) {
    if (!btn) return;
    const span = btn.querySelector('.g-btn-text');
    if (span) span.textContent = text;
    else btn.textContent = text;
}

/* Reset Google button to its default ready state */
function _resetGoogleBtn() {
    const btn = document.getElementById('googleSignInBtn');
    if (!btn) return;
    btn.disabled = false;
    _googleBtnLabel(btn, 'Continue with Google');
}

/* Map Firebase Auth error codes to user-friendly messages */
function _googleAuthErr(code) {
    switch (code) {
        case 'auth/popup-blocked':
            return 'Popup blocked. Trying redirect…';
        case 'auth/popup-closed-by-user':
        case 'auth/cancelled-popup-request':
            return ''; /* silent — user cancelled intentionally */
        case 'auth/account-exists-with-different-credential':
            return 'This email already has a password account. Sign in with your password to link Google.';
        case 'auth/network-request-failed':
            return 'Connection error. Check your internet and try again.';
        case 'auth/user-disabled':
            return 'This account has been disabled. Contact support.';
        case 'auth/too-many-requests':
            return 'Too many attempts. Please wait a moment.';
        case 'auth/operation-not-allowed':
            return 'Google sign-in is not enabled. Contact support.';
        default:
            return 'Google sign-in failed. Please try again.';
    }
}

/* Called after a successful Google sign-in (popup or redirect).
   firebase.js's onAuthStateChanged handles Firestore — we handle
   localStorage sync, analytics, and redirect here. */
async function _handleGoogleResult(result) {
    const user = result.user;

    /* Small delay so firebase.js's onAuthStateChanged can populate localStorage */
    await new Promise(resolve => setTimeout(resolve, 900));

    /* Fallback: write minimal profile if onAuthStateChanged was too slow */
    if (!localStorage.getItem('sokoniUser')) {
        const parts = (user.displayName || '').split(' ');
        const fallback = {
            uid:          user.uid,
            name:         user.displayName || user.email.split('@')[0],
            firstName:    parts[0] || '',
            lastName:     parts.slice(1).join(' ') || '',
            email:        user.email,
            photoURL:     user.photoURL || '',
            provider:     'google',
            emailVerified: user.emailVerified,
            roles:        ['buyer'],
            accountStatus: 'active',
        };
        localStorage.setItem('sokoniUser', JSON.stringify(fallback));
        localStorage.setItem('loggedIn', 'true');
    }

    /* SokoniSync */
    if (window.SokoniSync && window.firebaseDB) {
        window.SokoniSync.init(window.firebaseDB, user.uid);
        window.SokoniSync.pull(user.uid);
    } else if (window.firebaseDB) {
        window._sokoniSyncPending = { db: window.firebaseDB, uid: user.uid };
    }

    /* Analytics */
    if (typeof sokoniTrackLogin === 'function') sokoniTrackLogin();
    if (typeof SokoniAudit !== 'undefined') {
        SokoniAudit.log(SokoniAudit.ACTIONS.LOGIN_SUCCESS, {
            email: user.email, provider: 'google'
        });
    }

    /* Sessions */
    if (window.SokoniSessions && window.SokoniSessions.createSession) {
        window.SokoniSessions.createSession(user.email).catch(() => {});
    }

    showAuthMsg('Signed in with Google! Taking you home…', 'success');
    const btn = document.getElementById('googleSignInBtn');
    if (btn) { btn.disabled = true; _googleBtnLabel(btn, '✓ Signed in'); }

    const _raw  = sessionStorage.getItem('sokoniLoginRedirect') || 'index.html';
    sessionStorage.removeItem('sokoniLoginRedirect');
    const _safe = /^[a-zA-Z0-9_\-\.\/\?=&%#]+$/.test(_raw) && !_raw.includes('//') ? _raw : 'index.html';
    setTimeout(() => { window.location.href = _safe; }, 1200);
}

/* Handle auth/account-exists-with-different-credential.
   Stores the pending Google error on window so loginUser() can
   link the credential after a successful password sign-in. */
function _handleGoogleLinkError(err) {
    const email = (err.customData && err.customData.email) || '';
    /* Preserve the error object — GoogleAuthProvider.credentialFromError()
       needs it later in loginUser() */
    window._pendingGoogleLink = { error: err, email };

    const emailField = document.getElementById('loginEmail');
    if (emailField && email) emailField.value = email;

    showAuthMsg(
        'This email already has a password account. ' +
        'Sign in below to link your Google account automatically.',
        'error'
    );
    _resetGoogleBtn();
}

/* Main entry point — called by onclick="signInWithGoogle()" */
async function signInWithGoogle() {
    /* Offline guard */
    if (!navigator.onLine) {
        showAuthMsg('Google Sign-In requires an internet connection.', 'error');
        return;
    }
    if (!window.firebaseAuth) {
        showAuthMsg('Firebase not ready. Please refresh the page.', 'error');
        return;
    }

    const btn = document.getElementById('googleSignInBtn');
    if (btn) { btn.disabled = true; _googleBtnLabel(btn, 'Connecting to Google…'); }

    try {
        const {
            GoogleAuthProvider,
            signInWithPopup,
            signInWithRedirect,
        } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');

        const provider = new GoogleAuthProvider();
        provider.addScope('email');
        provider.addScope('profile');
        provider.setCustomParameters({ prompt: 'select_account' });

        if (_isPopupSupported()) {
            try {
                const result = await signInWithPopup(window.firebaseAuth, provider);
                await _handleGoogleResult(result);
            } catch (popupErr) {
                if (popupErr.code === 'auth/popup-blocked') {
                    /* Transparent fallback to redirect */
                    _googleBtnLabel(btn, 'Redirecting to Google…');
                    await signInWithRedirect(window.firebaseAuth, provider);
                } else if (popupErr.code === 'auth/account-exists-with-different-credential') {
                    _handleGoogleLinkError(popupErr);
                } else if (popupErr.code === 'auth/popup-closed-by-user' ||
                           popupErr.code === 'auth/cancelled-popup-request') {
                    _resetGoogleBtn(); /* silent */
                } else {
                    throw popupErr;
                }
            }
        } else {
            /* PWA / iOS — redirect flow */
            _googleBtnLabel(btn, 'Redirecting to Google…');
            await signInWithRedirect(window.firebaseAuth, provider);
        }
    } catch (err) {
        _resetGoogleBtn();
        const msg = _googleAuthErr(err.code);
        if (msg) showAuthMsg(msg, 'error');
    }
}

/* Receive redirect result dispatched by firebase.js after getRedirectResult()
   NOTE: firebase.js dispatches sokoniOAuthRedirectDone for ALL providers.
   The Google-specific name is kept for any legacy listeners. */
window.addEventListener('sokoniGoogleRedirectDone', async function(e) {
    await _handleGoogleResult(e.detail);
});
window.addEventListener('sokoniOAuthRedirectDone', async function(e) {
    const result     = e.detail;
    const providerId = result.user?.providerData?.[0]?.providerId || 'unknown';
    /* Google redirects already handled by sokoniGoogleRedirectDone above;
       this listener handles Facebook, Phone */
    if (providerId !== 'google.com') {
        await _handleOAuthResult(result, _providerLabel(providerId));
    }
});

window.addEventListener('sokoniGoogleRedirectError', function(e) {
    const err = e.detail;
    if (err.code === 'auth/account-exists-with-different-credential') {
        _handleGoogleLinkError(err);
    } else {
        const msg = _googleAuthErr(err.code);
        if (msg) showAuthMsg(msg, 'error');
        _resetGoogleBtn();
    }
});
window.addEventListener('sokoniOAuthRedirectError', function(e) {
    const err        = e.detail;
    const providerId = err.customData?._tokenResponse?.providerId || 'unknown';
    if (err.code === 'auth/account-exists-with-different-credential' && providerId !== 'google.com') {
        _handleProviderLinkError(err, _providerLabel(providerId));
    } else if (providerId === 'google.com') {
        _handleGoogleLinkError(err);
    } else {
        const msg = _googleAuthErr(err.code) || 'Sign-in failed. Please try again.';
        if (msg) showAuthMsg(msg, 'error');
    }
});

/* ══════════════════════════════════════════════════════════════
   UNIVERSAL OAUTH — Facebook (Google handled separately above)
   Popup with redirect fallback, account linking, post-auth profile.
══════════════════════════════════════════════════════════════ */

function _providerLabel(providerId) {
    const map = {
        'google.com':   'Google',
        'facebook.com': 'Facebook',
        'phone':        'Phone',
        'password':     'Email',
    };
    return map[providerId] || providerId;
}

async function _handleOAuthResult(result, providerLabel) {
    const user = result.user;

    await new Promise(function(resolve) { setTimeout(resolve, 900); });

    if (!localStorage.getItem('sokoniUser')) {
        const parts = (user.displayName || '').split(' ');
        const fallback = {
            uid:           user.uid,
            name:          user.displayName || (user.email || '').split('@')[0] || 'User',
            firstName:     parts[0] || '',
            lastName:      parts.slice(1).join(' ') || '',
            email:         user.email || '',
            photoURL:      user.photoURL || '',
            provider:      (providerLabel || 'oauth').toLowerCase(),
            emailVerified: user.emailVerified,
            roles:         ['buyer'],
            accountStatus: 'active',
        };
        localStorage.setItem('sokoniUser', JSON.stringify(fallback));
        localStorage.setItem('loggedIn', 'true');
    }

    if (window.SokoniSync && window.firebaseDB) {
        window.SokoniSync.init(window.firebaseDB, user.uid);
        window.SokoniSync.pull(user.uid);
    } else if (window.firebaseDB) {
        window._sokoniSyncPending = { db: window.firebaseDB, uid: user.uid };
    }

    if (typeof sokoniTrackLogin === 'function') sokoniTrackLogin();
    if (typeof SokoniAudit !== 'undefined') {
        SokoniAudit.log(SokoniAudit.ACTIONS.LOGIN_SUCCESS, {
            email: user.email, provider: (providerLabel || '').toLowerCase()
        });
    }
    if (window.SokoniSessions && window.SokoniSessions.createSession && user.email) {
        window.SokoniSessions.createSession(user.email).catch(function() {});
    }

    showAuthMsg('Signed in with ' + providerLabel + '! Taking you home…', 'success');

    const _raw  = sessionStorage.getItem('sokoniLoginRedirect') || 'index.html';
    sessionStorage.removeItem('sokoniLoginRedirect');
    const _safe = /^[a-zA-Z0-9_\-\.\/\?=&%#]+$/.test(_raw) && !_raw.includes('//') ? _raw : 'index.html';

    try {
        const profile = JSON.parse(localStorage.getItem('sokoniUser') || '{}');
        if (profile.onboardingRequired) {
            sessionStorage.setItem('sokoniPostOnboardingRedirect', _safe);
            setTimeout(function() { window.location.href = 'onboarding.html'; }, 1200);
            return;
        }
    } catch (_) {}

    setTimeout(function() { window.location.href = _safe; }, 1200);
}

function _handleProviderLinkError(err, providerLabel) {
    const email = (err.customData && err.customData.email) || '';
    window._pendingProviderLink = { error: err, email: email, provider: providerLabel };

    const emailField = document.getElementById('loginEmail');
    if (emailField && email) emailField.value = email;

    showAuthMsg(
        'This email already has a password account. ' +
        'Sign in below — your ' + providerLabel + ' account will link automatically.',
        'error'
    );
    document.querySelectorAll('.auth-social-btn').forEach(function(b) { b.disabled = false; });
    _resetGoogleBtn();
}

async function _signInWithOAuth(providerKey, providerLabel, configureFn) {
    if (!navigator.onLine) {
        showAuthMsg(providerLabel + ' Sign-In requires an internet connection.', 'error');
        return;
    }
    if (!window.firebaseAuth) {
        showAuthMsg('Firebase not ready. Please refresh the page.', 'error');
        return;
    }

    document.querySelectorAll('.auth-social-btn').forEach(function(b) { b.disabled = true; });
    const gBtn = document.getElementById('googleSignInBtn');
    if (gBtn) gBtn.disabled = true;
    showAuthMsg('Connecting to ' + providerLabel + '…', '');

    try {
        const {
            FacebookAuthProvider,
            signInWithPopup,
            signInWithRedirect,
            setPersistence,
            browserLocalPersistence,
            browserSessionPersistence,
        } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');

        const remember = document.getElementById('rememberMe')?.checked ?? true;
        await setPersistence(window.firebaseAuth,
            remember ? browserLocalPersistence : browserSessionPersistence
        ).catch(function() {});

        const provider = new FacebookAuthProvider();
        if (configureFn) configureFn(provider);

        try {
            if (_isPopupSupported()) {
                const result = await signInWithPopup(window.firebaseAuth, provider);
                await _handleOAuthResult(result, providerLabel);
            } else {
                await signInWithRedirect(window.firebaseAuth, provider);
            }
        } catch (err) {
            if (err.code === 'auth/popup-blocked') {
                await signInWithRedirect(window.firebaseAuth, provider);
            } else if (err.code === 'auth/account-exists-with-different-credential') {
                _handleProviderLinkError(err, providerLabel);
            } else if (err.code === 'auth/popup-closed-by-user' ||
                       err.code === 'auth/cancelled-popup-request') {
                showAuthMsg('', '');
                document.querySelectorAll('.auth-social-btn').forEach(function(b) { b.disabled = false; });
                if (gBtn) { gBtn.disabled = false; _googleBtnLabel(gBtn, 'Continue with Google'); }
            } else {
                throw err;
            }
        }
    } catch (err) {
        document.querySelectorAll('.auth-social-btn').forEach(function(b) { b.disabled = false; });
        if (gBtn) { gBtn.disabled = false; _googleBtnLabel(gBtn, 'Continue with Google'); }
        const msg = _googleAuthErr(err.code) || (providerLabel + ' sign-in failed. Please try again.');
        if (msg) showAuthMsg(msg, 'error');
    }
}

function signInWithFacebook() {
    _signInWithOAuth('facebook', 'Facebook', function(p) {
        p.addScope('email');
        p.addScope('public_profile');
    });
}

/* ══════════════════════════════════════════════════════════════
   PHONE OTP AUTHENTICATION
   Firebase Phone Auth with invisible reCAPTCHA.
   Default prefix: +254 (Kenya). User can type any international code.
══════════════════════════════════════════════════════════════ */
let _phoneConfirmResult = null;
let _recaptchaVerifier  = null;
let _otpTimerHandle     = null;

function openPhoneAuth() {
    const section = document.getElementById('phoneAuthSection');
    if (!section) return;
    const nowOpen = section.classList.toggle('open');
    if (nowOpen) {
        setTimeout(function() { document.getElementById('phoneNumber')?.focus(); }, 300);
    }
}

async function sendPhoneOTP() {
    const countryCode = ((document.getElementById('phoneCountryCode')?.value) || '+254').trim();
    const rawNumber   = ((document.getElementById('phoneNumber')?.value) || '').replace(/[\s\-()]/g, '').trim();

    if (!rawNumber || rawNumber.length < 6) {
        showAuthMsg('Please enter a valid phone number.', 'error');
        return;
    }

    const fullPhone = countryCode.startsWith('+') ? countryCode + rawNumber : '+' + countryCode + rawNumber;

    if (!navigator.onLine) {
        showAuthMsg('Phone OTP requires an internet connection.', 'error');
        return;
    }
    if (!window.firebaseAuth) {
        showAuthMsg('Firebase not ready. Please refresh the page.', 'error');
        return;
    }

    const btn = document.getElementById('sendOtpBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

    try {
        const { signInWithPhoneNumber, RecaptchaVerifier } = await import(
            'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'
        );

        const sendOtpBtn = document.getElementById('sendOtpBtn');
        if (!_recaptchaVerifier) {
            try {
                _recaptchaVerifier = new RecaptchaVerifier(window.firebaseAuth, 'sendOtpBtn', {
                    size: 'invisible',
                    'expired-callback': function() { _recaptchaVerifier = null; },
                });
            } catch (rcErr) {
                throw rcErr;
            }
        }

        _phoneConfirmResult = await signInWithPhoneNumber(window.firebaseAuth, fullPhone, _recaptchaVerifier);

        const otpEntry = document.getElementById('otpEntry');
        if (otpEntry) otpEntry.style.display = 'block';
        document.getElementById('otp0')?.focus();

        if (btn) { btn.disabled = false; btn.textContent = 'Resend OTP'; }
        _startOTPTimer(60);
        showAuthMsg('OTP sent to ' + fullPhone + '. Check your messages.', 'success');

    } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Send OTP →'; }
        _recaptchaVerifier = null;
        const _phoneErrMap = {
            'auth/invalid-phone-number':    'Invalid phone number. Please use the format +254 7XX XXX XXX.',
            'auth/too-many-requests':        'Too many attempts. Please try again later.',
            'auth/captcha-check-failed':     'Verification failed. Please refresh and try again.',
            'auth/quota-exceeded':           'SMS quota exceeded. Please try again later.',
            'auth/user-disabled':            'This account has been disabled.',
        };
        showAuthMsg(_phoneErrMap[err.code] || 'Could not send OTP. Please try again.', 'error');
    }
}

async function verifyPhoneOTP() {
    const code = [0,1,2,3,4,5].map(function(i) {
        return (document.getElementById('otp' + i)?.value || '').trim();
    }).join('');

    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
        showAuthMsg('Please enter the complete 6-digit code.', 'error');
        return;
    }
    if (!_phoneConfirmResult) {
        showAuthMsg('Session expired. Please request a new OTP.', 'error');
        return;
    }

    const btn = document.getElementById('verifyOtpBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }

    try {
        const result = await _phoneConfirmResult.confirm(code);
        clearInterval(_otpTimerHandle);
        await _handleOAuthResult(result, 'Phone');
    } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Verify →'; }
        const _otpErrMap = {
            'auth/invalid-verification-code': 'Incorrect code. Please check and try again.',
            'auth/code-expired':              'Code expired. Please request a new OTP.',
            'auth/too-many-requests':         'Too many attempts. Please request a new OTP.',
        };
        showAuthMsg(_otpErrMap[err.code] || 'Verification failed. Please try again.', 'error');
    }
}

function resendPhoneOTP() {
    _phoneConfirmResult = null;
    _recaptchaVerifier  = null;
    [0,1,2,3,4,5].forEach(function(i) {
        const el = document.getElementById('otp' + i);
        if (el) { el.value = ''; el.classList.remove('filled'); }
    });
    const resendEl = document.getElementById('otpResendLink');
    if (resendEl) resendEl.style.display = 'none';
    sendPhoneOTP();
}

function _startOTPTimer(seconds) {
    const timerEl  = document.getElementById('otpTimerDisplay');
    const resendEl = document.getElementById('otpResendLink');
    let remaining  = seconds;

    if (timerEl)  timerEl.textContent = 'Resend in ' + remaining + 's';
    if (resendEl) resendEl.style.display = 'none';

    clearInterval(_otpTimerHandle);
    _otpTimerHandle = setInterval(function() {
        remaining--;
        if (remaining <= 0) {
            clearInterval(_otpTimerHandle);
            if (timerEl)  timerEl.textContent = '';
            if (resendEl) resendEl.style.display = 'inline';
        } else {
            if (timerEl) timerEl.textContent = 'Resend in ' + remaining + 's';
        }
    }, 1000);
}

function _setupOtpInputs() {
    [0,1,2,3,4,5].forEach(function(i) {
        const el = document.getElementById('otp' + i);
        if (!el) return;

        el.addEventListener('input', function() {
            this.value = this.value.replace(/\D/g, '').slice(0, 1);
            this.classList.toggle('filled', this.value.length > 0);
            if (this.value && i < 5) {
                document.getElementById('otp' + (i + 1))?.focus();
            }
            if (i === 5 && this.value) {
                const all = [0,1,2,3,4,5].map(function(j) {
                    return document.getElementById('otp' + j)?.value || '';
                }).join('');
                if (all.length === 6) setTimeout(verifyPhoneOTP, 150);
            }
        });

        el.addEventListener('keydown', function(e) {
            if (e.key === 'Backspace' && !this.value && i > 0) {
                document.getElementById('otp' + (i - 1))?.focus();
            }
        });

        el.addEventListener('paste', function(e) {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData)
                .getData('text').replace(/\D/g, '').slice(0, 6);
            [...text].forEach(function(ch, j) {
                const t = document.getElementById('otp' + (i + j));
                if (t) { t.value = ch; t.classList.add('filled'); }
            });
            document.getElementById('otp' + Math.min(i + text.length, 5))?.focus();
        });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _setupOtpInputs);
} else {
    _setupOtpInputs();
}

/* ══════════════════════════════════════════════════════════════
   REMEMBER ME — Firebase persistence toggle
══════════════════════════════════════════════════════════════ */
async function _setPersistenceFromUI() {
    try {
        const remember = document.getElementById('rememberMe')?.checked ?? true;
        const { setPersistence, browserLocalPersistence, browserSessionPersistence } = await import(
            'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'
        );
        await setPersistence(
            window.firebaseAuth,
            remember ? browserLocalPersistence : browserSessionPersistence
        );
    } catch (err) {
        /* persistence failure is non-fatal; auth continues with default persistence */
    }
}

function toggleLoginPw() {
    const f = document.getElementById('loginPassword');
    if (!f) return;
    f.type = f.type === 'password' ? 'text' : 'password';
}

/* ══════════════════════════════════════════════════════════════
   PENDING PROVIDER LINK — non-Google OAuth credential linking
   Called from loginUser() after successful password sign-in
   when _pendingProviderLink is set by _handleProviderLinkError.
══════════════════════════════════════════════════════════════ */
async function _linkPendingProvider(credUser, email) {
    if (!window._pendingProviderLink) return;
    try {
        const {
            FacebookAuthProvider,
            linkWithCredential,
        } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');

        const err      = window._pendingProviderLink.error;
        const provider = window._pendingProviderLink.provider;
        let pendingCred;

        if (provider === 'Facebook') {
            pendingCred = FacebookAuthProvider.credentialFromError(err);
        }

        if (pendingCred) {
            await linkWithCredential(credUser, pendingCred);
            try {
                const { doc, setDoc, serverTimestamp: _sts } = await import(
                    'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
                );
                await setDoc(
                    doc(window.firebaseDB, 'users', credUser.uid),
                    { linkedProviders: [provider.toLowerCase()], linkedAt: _sts() },
                    { merge: true }
                );
            } catch (_) {}
            if (typeof SokoniAudit !== 'undefined') {
                SokoniAudit.log(provider.toUpperCase() + '_ACCOUNT_LINKED', { email });
            }
        }
    } catch (_) {}
    finally { window._pendingProviderLink = null; }
}
