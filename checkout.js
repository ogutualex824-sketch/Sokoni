/* ============================================================
   checkout.js — geolocation only
   All payment/order logic lives in the checkout.html inline script
============================================================ */

window.deliveryLocation = null;

if("geolocation" in navigator){
    navigator.geolocation.getCurrentPosition(
        pos => {
            window.deliveryLocation = {
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracy: Math.round(pos.coords.accuracy),
                address: `${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`
            };
            const el = document.getElementById("locationStatus");
            if(el) el.innerHTML = `<span class="loc-ok"><i class="fas fa-map-marker-alt"></i> Location captured — faster delivery</span>`;
        },
        () => {
            const el = document.getElementById("locationStatus");
            if(el) el.innerHTML = `<span class="loc-warn"><i class="fas fa-exclamation-triangle"></i> Share location for faster delivery</span>`;
        }
    );
}
