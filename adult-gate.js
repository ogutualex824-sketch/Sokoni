/* ==============================================
   SOKONI — 18+ AGE + ID VERIFICATION GATE
   Used on any page that has adult products.
   Step 1: Date of birth (18+ check)
   Step 2: Kenya National ID number (format check)
   ============================================== */

const ADULT_CATS = ["vape", "alcohol", "tobacco", "adult"];

function isAdultCategory(cat){
    return ADULT_CATS.includes((cat || "").toLowerCase());
}

function isAgeVerified(){
    return sessionStorage.getItem("sokoniAgeVerified") === "true" ||
           localStorage.getItem("sokoniAgeVerified") === "true";
}

function setAgeVerified(){
    sessionStorage.setItem("sokoniAgeVerified", "true");
    localStorage.setItem("sokoniAgeVerified", "true");
}

/* Show the gate modal. Returns a promise that resolves true/false */
function requireAgeVerification(){
    return new Promise((resolve) => {
        if(isAgeVerified()){ resolve(true); return; }

        if(!document.getElementById("ageGateModal")){
            _injectGateStyles();
            const el = document.createElement("div");
            el.innerHTML = `
            <div id="ageGateModal" class="age-gate-overlay">
                <div class="age-gate-box">

                    <div class="age-gate-logo">
                        <img src="assets/Sokoni Logo.png" alt="Sokoni">
                    </div>

                    <div class="age-gate-warning">⚠️ 18+ Content</div>
                    <h2>Age &amp; ID Verification</h2>
                    <p>This section contains products available only to adults aged 18+.
                       Regulated under Kenya's Alcoholic Drinks Control Act (2010) and
                       Tobacco Control Act (2007).</p>

                    <!-- ── STEP 1: Date of birth ── -->
                    <div id="agStep1" class="ag-step">
                        <div class="ag-step-label">
                            <span class="ag-step-num">1</span> Enter your date of birth
                        </div>
                        <div class="dob-inputs">
                            <input type="number" id="ageDobDay"   placeholder="DD"   min="1"    max="31"   maxlength="2">
                            <span class="dob-sep">/</span>
                            <input type="number" id="ageDobMonth" placeholder="MM"   min="1"    max="12"   maxlength="2">
                            <span class="dob-sep">/</span>
                            <input type="number" id="ageDobYear"  placeholder="YYYY" min="1900" max="2099" maxlength="4">
                        </div>
                        <div id="ageGateError" class="age-gate-error" style="display:none;"></div>
                        <button class="age-confirm-btn" onclick="confirmDOB()">Next — Verify ID →</button>
                    </div>

                    <!-- ── STEP 2: National ID ── -->
                    <div id="agStep2" class="ag-step" style="display:none;">
                        <div class="ag-step-label">
                            <span class="ag-step-num">2</span> Enter your Kenya National ID number
                        </div>
                        <div class="ag-id-row">
                            <span class="ag-id-icon">🪪</span>
                            <input type="text" id="ageNationalId"
                                   placeholder="e.g. 12345678"
                                   maxlength="9"
                                   inputmode="numeric"
                                   class="ag-id-input"
                                   oninput="this.value=this.value.replace(/\D/g,'')">
                        </div>
                        <p class="ag-id-hint">Your National ID number is 7–8 digits (found on your Kenyan ID card).
                           We do <strong>not</strong> store or share this number — it is verified locally on your device only.</p>
                        <div id="ageIdError" class="age-gate-error" style="display:none;"></div>

                        <div class="ag-id-btns">
                            <button class="age-confirm-btn" onclick="confirmID()">✅ Verify &amp; Enter</button>
                            <button class="ag-back-btn" onclick="backToDOB()">← Back</button>
                        </div>
                    </div>

                    <!-- ── STEP 3: Verified success flash ── -->
                    <div id="agStep3" class="ag-step" style="display:none;">
                        <div class="ag-verified-badge">
                            <span class="ag-check">✓</span>
                            <div>
                                <div class="ag-verified-title">Identity Verified</div>
                                <div class="ag-verified-sub">Welcome — entering 18+ section</div>
                            </div>
                        </div>
                    </div>

                    <a href="index.html" class="age-leave-btn" id="agLeaveBtn">← Leave (Under 18)</a>

                    <p class="age-gate-legal">By entering, you confirm you are 18+ and comply with Kenyan law.
                       This site does not sell regulated products to minors.</p>
                </div>
            </div>
            `;
            document.body.appendChild(el.firstElementChild);
        }

        document.getElementById("ageGateModal").style.display = "flex";
        document.body.style.overflow = "hidden";
        window._ageGateResolve = resolve;
    });
}

/* ── DOB confirmation ── */
function confirmDOB(){
    const day   = Number(document.getElementById("ageDobDay").value);
    const month = Number(document.getElementById("ageDobMonth").value);
    const year  = Number(document.getElementById("ageDobYear").value);
    const errEl = document.getElementById("ageGateError");

    errEl.style.display = "none";

    if(!day || !month || !year || year < 1900 || year > new Date().getFullYear()){
        errEl.textContent = "Please enter a valid date of birth.";
        errEl.style.display = "block";
        return;
    }

    const dob = new Date(year, month - 1, day);
    if(isNaN(dob.getTime())){
        errEl.textContent = "Invalid date — please check day and month.";
        errEl.style.display = "block";
        return;
    }

    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if(m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;

    if(age < 18){
        errEl.textContent = `You must be 18 or older. Based on this date you are ${age} year${age!==1?"s":""} old.`;
        errEl.style.display = "block";
        return;
    }

    /* Age passed — move to ID step */
    document.getElementById("agStep1").style.display = "none";
    document.getElementById("agStep2").style.display = "block";
    document.getElementById("ageNationalId").focus();
}

/* ── ID confirmation ── */
function confirmID(){
    const idVal  = (document.getElementById("ageNationalId").value || "").trim();
    const errEl  = document.getElementById("ageIdError");
    errEl.style.display = "none";

    /* Kenya National ID: 7 or 8 digits */
    if(!/^\d{7,8}$/.test(idVal)){
        errEl.textContent = "Please enter a valid Kenya National ID (7 or 8 digits).";
        errEl.style.display = "block";
        return;
    }

    /* Show verified badge briefly, then resolve */
    document.getElementById("agStep2").style.display = "none";
    document.getElementById("agStep3").style.display = "block";
    document.getElementById("agLeaveBtn").style.display = "none";

    setAgeVerified();

    setTimeout(() => {
        const modal = document.getElementById("ageGateModal");
        if(modal) modal.style.display = "none";
        document.body.style.overflow = "";
        if(window._ageGateResolve) window._ageGateResolve(true);
    }, 1400);
}

function backToDOB(){
    document.getElementById("agStep2").style.display = "none";
    document.getElementById("agStep1").style.display = "block";
    document.getElementById("ageIdError").style.display = "none";
    document.getElementById("ageNationalId").value = "";
}

/* ── Styles injected once ── */
function _injectGateStyles(){
    if(document.getElementById("ag-extra-styles")) return;
    const s = document.createElement("style");
    s.id = "ag-extra-styles";
    s.textContent = `
        /* ── GLASS OVERLAY (works on any page without style.css) ── */
        .age-gate-overlay{
            position:fixed;inset:0;z-index:999999;
            background:rgba(0,0,0,0.88);
            backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
            display:flex;align-items:flex-start;justify-content:center;
            overflow-y:auto;padding:20px;
        }
        .age-gate-box{
            background:rgba(12,12,12,0.97);
            border:1px solid rgba(255,68,0,0.3);
            border-radius:28px;padding:40px 36px;
            max-width:480px;width:100%;text-align:center;
            box-shadow:0 24px 64px rgba(0,0,0,0.8),0 0 0 1px rgba(255,68,0,0.1);
            font-family:'Segoe UI',system-ui,sans-serif;
            margin:auto;
        }
        .age-gate-logo img{ width:120px;margin:0 auto 16px;display:block; }
        .age-gate-warning{
            background:rgba(255,68,0,0.12);border:1px solid rgba(255,68,0,0.3);
            color:#ff8800;padding:6px 16px;border-radius:999px;font-size:13px;
            font-weight:800;display:inline-block;margin-bottom:16px;letter-spacing:.5px;
        }
        .age-gate-box h2{ color:white;font-size:24px;font-weight:900;margin-bottom:12px; }
        .age-gate-box p{
            color:rgba(255,255,255,0.5);font-size:14px;line-height:1.6;margin-bottom:24px;
        }
        .dob-inputs{
            display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:14px;
        }
        .dob-inputs input{
            width:70px;padding:12px 8px;
            background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);
            border-radius:12px;color:white;font-size:16px;font-weight:700;
            text-align:center;outline:none;font-family:inherit;
            -webkit-appearance:none;-moz-appearance:textfield;appearance:textfield;
        }
        .dob-inputs input::-webkit-outer-spin-button,
        .dob-inputs input::-webkit-inner-spin-button{ -webkit-appearance:none; }
        .dob-inputs input:focus{ border-color:rgba(255,136,0,0.5); }
        .age-gate-error{
            background:rgba(255,61,61,0.12);border:1px solid rgba(255,61,61,0.28);
            color:#ff6b6b;padding:10px 16px;border-radius:10px;
            font-size:13px;font-weight:600;margin-bottom:12px;
        }
        .age-confirm-btn{
            width:100%;padding:15px;
            background:linear-gradient(135deg,#ff4400,#ff8800);
            color:white;font-weight:900;font-size:15px;border:none;
            border-radius:14px;cursor:pointer;transition:.3s;font-family:inherit;
            margin-top:4px;
        }
        .age-confirm-btn:hover{ transform:translateY(-2px);box-shadow:0 8px 24px rgba(255,68,0,0.35); }
        .age-leave-btn{
            display:block;color:rgba(255,255,255,0.35);text-decoration:none;
            font-size:13px;transition:.2s;margin-top:18px;
        }
        .age-leave-btn:hover{ color:rgba(255,255,255,0.6); }
        .age-gate-legal{
            color:rgba(255,255,255,0.2);font-size:11px;line-height:1.5;
            margin-top:20px;border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;
        }
        @media(max-width:480px){
            .age-gate-box{ padding:28px 20px; }
            .dob-inputs input{ width:58px; }
        }

        /* Step header */
        .ag-step-label{
            display:flex; align-items:center; gap:10px;
            font-size:13px; font-weight:700; color:rgba(255,255,255,0.65);
            margin-bottom:14px;
        }
        .ag-step-num{
            width:24px; height:24px; border-radius:50%;
            background:rgba(113,255,0,0.15); border:1px solid rgba(113,255,0,0.35);
            color:#71ff00; font-size:12px; font-weight:900;
            display:flex; align-items:center; justify-content:center; flex-shrink:0;
        }

        /* ID input row */
        .ag-id-row{
            display:flex; align-items:center; gap:10px;
            background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.12);
            border-radius:12px; padding:12px 14px; margin-bottom:10px;
        }
        .ag-id-icon{ font-size:22px; flex-shrink:0; }
        .ag-id-input{
            flex:1; background:transparent; border:none; outline:none;
            color:white; font-size:16px; font-weight:700; font-family:inherit;
            letter-spacing:1.5px;
        }
        .ag-id-input::placeholder{ color:rgba(255,255,255,0.3); letter-spacing:0; font-weight:400; }
        .ag-id-hint{
            font-size:11px; color:rgba(255,255,255,0.35); line-height:1.5;
            margin-bottom:14px;
        }
        .ag-id-hint strong{ color:rgba(255,255,255,0.55); }

        /* Buttons row */
        .ag-id-btns{ display:flex; gap:10px; }
        .ag-back-btn{
            padding:12px 18px; background:rgba(255,255,255,0.05);
            border:1px solid rgba(255,255,255,0.1); border-radius:12px;
            color:rgba(255,255,255,0.5); font-weight:700; font-size:14px;
            cursor:pointer; font-family:inherit; transition:all .2s;
        }
        .ag-back-btn:hover{ background:rgba(255,255,255,0.08); color:white; }

        /* DOB separator */
        .dob-sep{ color:rgba(255,255,255,0.3); font-size:20px; font-weight:300; }

        /* Verified badge */
        .ag-verified-badge{
            display:flex; align-items:center; gap:14px;
            background:rgba(113,255,0,0.08); border:1px solid rgba(113,255,0,0.25);
            border-radius:14px; padding:18px; margin:8px 0 16px;
            animation:agVerifiedPop .3s ease;
        }
        @keyframes agVerifiedPop{
            from{ transform:scale(0.9); opacity:0; }
            to{   transform:scale(1);   opacity:1; }
        }
        .ag-check{
            width:44px; height:44px; border-radius:50%;
            background:linear-gradient(135deg,#71ff00,#4fc800);
            color:black; font-size:22px; font-weight:900;
            display:flex; align-items:center; justify-content:center; flex-shrink:0;
        }
        .ag-verified-title{ font-size:15px; font-weight:900; color:white; }
        .ag-verified-sub{ font-size:12px; color:rgba(255,255,255,0.45); margin-top:2px; }
    `;
    document.head.appendChild(s);
}

window.confirmDOB  = confirmDOB;
window.confirmID   = confirmID;
window.backToDOB   = backToDOB;
/* legacy alias — some pages call confirmAge() directly */
window.confirmAge  = confirmDOB;
window.requireAgeVerification = requireAgeVerification;
window.isAdultCategory = isAdultCategory;
window.isAgeVerified   = isAgeVerified;
