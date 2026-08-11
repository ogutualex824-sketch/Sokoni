/* USER */
const _esc = s => String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let user = null;
try { user = JSON.parse(localStorage.getItem("sokoniUser")); } catch(e) {}

const loggedIn = localStorage.getItem("loggedIn");

/* CHECK LOGIN */

if(loggedIn !== "true"){
    /* Session flag ALONE — not the sokoniUser cache. Requiring `user` here (the
       old `|| !user`) bounced a logged-in account whose profile cache was empty
       or blocked by App Check to login.html, feeding the profile↔login loop (the
       same anti-pattern as auth-guard.js and the isLoggedIn u.name bug). */
    try {
        console.warn('[SOKONI AUTH REDIRECT]', { page: location.pathname, loggedIn: loggedIn, hasUser: !!user, reason: 'profile.js→login' });
        var _l = JSON.parse(localStorage.getItem('sk_auth_redirects') || '[]');
        _l.push({ t: Date.now(), page: location.pathname, loggedIn: loggedIn, hasUser: !!user, reason: 'profile.js→login' });
        while (_l.length > 25) _l.shift();
        localStorage.setItem('sk_auth_redirects', JSON.stringify(_l));
    } catch(e) {}
    /* Delay redirect so splash animation (600ms hide + 520ms fade = ~1120ms) can complete */
    setTimeout(function(){ window.location.href = "login.html"; }, 1200);
    throw new Error("redirect");
}
if(!user) user = {};   /* profile cache absent — proceed; firebase/bootstrap fills it. Never redirect for a missing cache. */



/* DISPLAY USER */

const _pName = document.getElementById("profileName");
if (_pName) _pName.innerText = user.name || '';

const _pEmail = document.getElementById("profileEmail");
if (_pEmail) _pEmail.innerText = user.email || '';



/* WISHLIST + CART */
/* The wishlist count read localStorage['wishlist'] — a per-device key that is now retired.
   It rendered into #wishlistCount, which profile.html has not contained for some time, so
   the read fed nothing; it is removed rather than rerouted, so this page takes no
   dependency it does not use.

   If a wishlist count returns to this page it must come from SokoniWishlist.count() after
   load() resolves (add <script src="sokoni-wishlist.js"> above profile.js), and must show
   "—" until it does. A count is a business metric: an unresolved read rendered as 0 tells
   the owner their saved items are gone. Never reintroduce a localStorage wishlist read. */
const cart = JSON.parse(localStorage.getItem("cart") || "[]");
/* Null-guarded like every other lookup in this file. profile.html no longer renders
   #cartItemsCount, and this was one of the two unguarded lines — so they threw on every
   load and aborted the whole of the rest of profile.js (orders list, tabs, and the
   header/menu wiring below). */
const _cartCountEl = document.getElementById("cartItemsCount");
if (_cartCountEl) _cartCountEl.innerText = cart.length;

/* ORDERS */
let orders = [];
try { orders = JSON.parse(localStorage.getItem("sokoniOrders")) || []; } catch(e) {}
const totalOrdersEl = document.getElementById("totalOrdersCount");
if(totalOrdersEl) totalOrdersEl.innerText = orders.length;

const statusLabels = { placed:"✅ Placed", processing:"⚙️ Processing", shipped:"🚚 Shipped", out_for_delivery:"🛵 Out for Delivery", delivered:"📦 Delivered" };

const ordersList = document.getElementById("profileOrdersList");
if(ordersList){
    if(orders.length === 0){
        ordersList.innerHTML = `<p style="color:rgba(255,255,255,0.3);font-size:14px;padding:12px 0;">No orders yet. <a href="/" style="color:#71ff00;">Start shopping →</a></p>`;
    } else {
        ordersList.innerHTML = orders.slice(0,4).map(o => {
            const trackUrl = o.deliveryRef
                ? `delivery-tracking.html?ref=${encodeURIComponent(o.deliveryRef)}`
                : `track.html?id=${encodeURIComponent(o.id)}`;
            return `
            <div class="profile-order-card" onclick="window.location.href='${trackUrl}'" style="cursor:pointer;">
                <div>
                    <h3>${_esc(o.id)}</h3>
                    <p>${_esc(o.date)} · ${(o.items||[]).length} item(s)</p>
                </div>
                <div style="text-align:right;">
                    <div style="color:white;font-weight:800;margin-bottom:4px;">KES ${Number(o.total).toLocaleString()}</div>
                    <div class="profile-order-status status-${_esc(o.status)}">${_esc(statusLabels[o.status] || o.status)}</div>
                </div>
            </div>`;
        }).join("");
    }
}

/* LOYALTY POINTS */
let pointsData = { total:0, history:[] };
try { pointsData = JSON.parse(localStorage.getItem("sokoniPoints")) || pointsData; } catch(e) {}

const pts = pointsData.total;
const tiers = [
    { name:"🥉 Bronze", min:0,    max:99,   next:100  },
    { name:"🥈 Silver", min:100,  max:499,  next:500  },
    { name:"🥇 Gold",   min:500,  max:999,  next:1000 },
    { name:"💎 Platinum", min:1000, max:Infinity, next:null },
];
const tier = tiers.find(t => pts >= t.min && pts <= t.max) || tiers[0];

const ptsEl    = document.getElementById("profilePoints");
const tierEl   = document.getElementById("profileTier");
const badgeEl  = document.getElementById("tierBadge");
const totalEl  = document.getElementById("pointsTotal");
const barEl    = document.getElementById("pointsBar");
const nextEl   = document.getElementById("pointsNext");

if(ptsEl)   ptsEl.innerText  = `${pts} pts`;
if(tierEl)  tierEl.innerText = tier.name;
if(badgeEl) badgeEl.innerText = tier.name;
if(totalEl) totalEl.innerText = `${pts} Points`;

const pct = tier.next ? Math.min(100, Math.round(((pts - tier.min) / (tier.next - tier.min)) * 100)) : 100;
if(barEl) barEl.style.width = pct + "%";
if(nextEl) nextEl.innerText = tier.next ? `${tier.next - pts} pts to reach next tier` : "🏆 Max tier reached!";

const rewards = [[100,"r100"],[300,"r300"],[500,"r500"],[1000,"r1000"]];
rewards.forEach(([threshold, id]) => {
    const el = document.getElementById(id);
    if(!el) return;
    if(pts >= threshold){
        el.textContent = "✅ Unlocked";
        el.classList.replace("reward-locked", "reward-unlocked");
    }
});

/* MESSAGES PREVIEW */
let msgs = [];
try { msgs = JSON.parse(localStorage.getItem("sokoniMessages")) || []; } catch(e) {}
const msgsList = document.getElementById("profileMessagesList");
if(msgsList){
    if(msgs.length === 0){
        msgsList.innerHTML = `<p style="color:rgba(255,255,255,0.3);font-size:14px;padding:12px 0;">No messages. <a href="messages.html" style="color:#71ff00;">Start a chat →</a></p>`;
    } else {
        msgsList.innerHTML = msgs.slice(0,3).map(c => `
            <div class="profile-order-card" onclick="window.location.href='messages.html?convo=${c.id}'" style="cursor:pointer;">
                <div>
                    <h3>${_esc(c.productName || "General Inquiry")}</h3>
                    <p>${c.messages&&c.messages.length > 0 ? _esc(c.messages[c.messages.length-1].text.substring(0,50)) : "—"}</p>
                </div>
                ${c.unread > 0 ? `<div class="convo-badge">${c.unread}</div>` : ""}
            </div>
        `).join("");
    }
}



/* PROFILE IMAGE */

const savedImage = localStorage.getItem(

    "profileImage"

);



if(savedImage){

    document.getElementById(

        "profileImage"

    ).src = savedImage;

}



/* CHANGE IMAGE */

function changeProfileImage(event){

    const file = event.target.files[0];



    if(!file) return;



    const reader = new FileReader();



    reader.onload = function(e){

        document.getElementById(

            "profileImage"

        ).src = e.target.result;



        localStorage.setItem(

            "profileImage",

            e.target.result

        );

    };



    reader.readAsDataURL(file);

}



/* LOGOUT */

function logoutUser(){
    /* Delete this device's Firestore session, then sign out of Firebase Auth */
    const _doLogout = () => {
        /* sokoniSignOut() is defined in firebase.js — clears Firebase Auth session
           plus loggedIn / sokoniUser / sokoniCreds localStorage keys */
        if(window.sokoniSignOut){
            window.sokoniSignOut().finally(() => {
                localStorage.removeItem("sokoniSessionId");
                window.location.href = "login.html";
            });
        } else {
            localStorage.removeItem("loggedIn");
            localStorage.removeItem("sokoniUser");
            localStorage.removeItem("sokoniSessionId");
            window.location.href = "login.html";
        }
    };
    if(window.SokoniSessions?.deleteCurrentSession){
        window.SokoniSessions.deleteCurrentSession().then(_doLogout).catch(_doLogout);
    } else {
        _doLogout();
    }
}



/* ROLE MANAGEMENT */

function displayUserRoles(){
    const user = JSON.parse(localStorage.getItem("sokoniUser"));
    if(!user || !user.registeredAs) return;
    
    const rolesList = document.getElementById("userRolesList");
    if(!rolesList) return;
    
    const roles = user.registeredAs;
    const roleDefinitions = {
        buyer: { icon: "🛍️", label: "Buyer", color: "#71ff00", dash: "index.html" },
        seller: { icon: "🏪", label: "Seller", color: "#00d4ff", dash: "seller.html" },
        healthcare: { icon: "🏥", label: "Healthcare", color: "#00d4ff", dash: "healthcare.html" },
        mechanic: { icon: "🔧", label: "Mechanic", color: "#fb923c", dash: "mechanics.html" },
        driver: { icon: "🚗", label: "Driver", color: "#fb923c", dash: "driver.html" },
        delivery: { icon: "📦", label: "Delivery", color: "#9b59b6", dash: "delivery.html" },
        landlord: { icon: "🏠", label: "Landlord", color: "#2ecc71", dash: "landlord.html" },
        legal: { icon: "⚖️", label: "Legal", color: "#e74c3c", dash: "legal-hub.html" }
    };
    
    let html = "";
    for(const [role, active] of Object.entries(roles)){
        if(active && roleDefinitions[role]){
            const def = roleDefinitions[role];
            html += `<div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:14px;text-align:center;cursor:pointer;transition:all .2s;" onmouseover="this.style.borderColor='${def.color}'" onmouseout="this.style.borderColor='rgba(255,255,255,0.1)'" onclick="window.location.href='${def.dash}'">
                <div style="font-size:28px;margin-bottom:6px;">${def.icon}</div>
                <div style="font-size:13px;font-weight:700;color:white;margin-bottom:4px;">${def.label}</div>
                <div style="font-size:11px;color:rgba(255,255,255,0.4);">Go to dashboard →</div>
            </div>`;
        }
    }
    
    rolesList.innerHTML = html;
}

function editUserRoles(){
    if(typeof SokoniAccessControl !== "undefined" && SokoniAccessControl.showRoleSelectionModal){
        SokoniAccessControl.showRoleSelectionModal();
        setTimeout(() => displayUserRoles(), 1000);
    }
}


/* GLOBAL */

window.changeProfileImage =

changeProfileImage;

window.logoutUser = logoutUser;

window.displayUserRoles = displayUserRoles;

window.editUserRoles = editUserRoles;

/* INITIALIZE ROLES ON PAGE LOAD */
document.addEventListener("DOMContentLoaded", function(){
    displayUserRoles();
});