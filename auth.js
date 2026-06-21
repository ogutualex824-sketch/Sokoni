/* ================================================================
   SOKONI — Authentication  (non-module; uses window.firebaseAuth
   and window.firebaseDB exposed by the firebase.js module)

   Functions are global so onclick= handlers in login.html and
   signup.html can call them directly.
================================================================ */

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

    const btn = document.querySelector(".auth-btn");
    if(btn){ btn.disabled = true; btn.textContent = "Signing in…"; }

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
        const { createUserWithEmailAndPassword, updateProfile } = await import(
            "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"
        );
        const { doc, setDoc, serverTimestamp } = await import(
            "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
        );

        /* Create Firebase Auth account */
        const cred = await createUserWithEmailAndPassword(window.firebaseAuth, email, password);
        await updateProfile(cred.user, { displayName: name });

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
            productName: "Welcome to Sokoni! 🎉",
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
    } else if(user.registeredAs.healthcare){
        dest  = "healthcare.html";
        label = "Opening Healthcare Hub…";
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
