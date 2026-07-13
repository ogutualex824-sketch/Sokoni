/* ============================================================
   SOKONI REVENUE ENGINE — Client-side helpers
   Sellers receive money directly. SOKONI tracks commission owed.
============================================================ */

window.SokoniRevenue = (() => {

  /* The commission table used to be hand-copied here — its own comment said it "mirrors server
     HUB_COMMISSION_DEFAULTS", and it had already fallen behind (it was missing `saas`).
     Rates now come from SokoniCommission (sokoni-commission-rates.js, generated from
     functions/commission-config.js), so this file cannot drift from the server again.
     The labels are presentation, not pricing, so they stay. */
  const HUB_LABELS = {
    marketplace: "Marketplace", restaurant: "Restaurant", food: "Food", freelance: "Freelance",
    property: "Property", vehicles: "Vehicles", healthcare: "Healthcare", legal: "Legal",
    bnb: "BnB", digital: "Digital", b2b: "B2B", delivery: "Delivery",
    entertainment: "Entertainment", saas: "SaaS", default: "Other",
  };
  /* Always a number — SokoniCommission.pct() falls back to the platform default itself. */
  const _rate = (hub) => ({
    pct:      window.SokoniCommission ? window.SokoniCommission.pct(hub)      : 5,
    fixedKES: window.SokoniCommission ? window.SokoniCommission.fixedKES(hub) : 0,
    label:    HUB_LABELS[hub] || HUB_LABELS.default,
  });

  /* ── Subscription plans ── */
  const PLANS = {
    free:       { name: "Free",       priceKES: 0,    tier: 0, maxListings: 10,  color: "#aaa"    },
    pro:        { name: "Pro",        priceKES: 999,  tier: 1, maxListings: -1,  color: "#71ff00" },
    business:   { name: "Business",   priceKES: 2999, tier: 2, maxListings: -1,  color: "#00d4ff" },
    enterprise: { name: "Enterprise", priceKES: 0,    tier: 3, maxListings: -1,  color: "#ff9500" },
  };

  const PLAN_FEATURES = {
    free:       ["10 product listings", "Basic analytics", "WhatsApp support"],
    pro:        ["Unlimited listings", "Advanced analytics", "Featured placement", "Priority search", "Remove SOKONI branding"],
    business:   ["Everything in Pro", "Team management (5 users)", "Marketing automation", "Bulk upload tools", "API access (read)", "Priority support"],
    enterprise: ["Everything in Business", "Unlimited team users", "Custom integrations", "Dedicated account manager", "Full API access", "SLA guarantee"],
  };

  /* ── Featured listing pricing ── */
  const FEATURED_PRICING = {
    daily:   { priceKES: 200,  label: "1 Day",   icon: "⚡" },
    weekly:  { priceKES: 800,  label: "7 Days",  icon: "🔥" },
    monthly: { priceKES: 2500, label: "30 Days", icon: "🏆" },
  };

  /* ── Ad CPM pricing ── */
  const AD_CPM = 150; // KES per 1,000 impressions

  /* ── Estimate commission for display ── */
  function estimateCommission(hub, grossAmount) {
    const rate = _rate(hub);
    const commKES  = grossAmount * rate.pct / 100;
    const minKES   = 10;
    const totalOwed = Math.max(commKES, rate.pct > 0 ? minKES : 0) + rate.fixedKES;
    const netKES   = grossAmount - totalOwed;
    return {
      pct: rate.pct,
      fixedKES: rate.fixedKES,
      commissionKES: Math.round(commKES * 100) / 100,
      totalOwed: Math.round(totalOwed * 100) / 100,
      netKES: Math.round(netKES * 100) / 100,
    };
  }

  /* ── Format KES amount ── */
  function fmtKES(n) {
    return "KES " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  /* ── Format period "2026-06" → "Jun 2026" ── */
  function fmtPeriod(p) {
    if (!p || !p.includes("-")) return p || "";
    const [y, m] = p.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return (months[Number(m) - 1] || m) + " " + y;
  }

  /* ── Status badge HTML ── */
  function statusBadge(status) {
    const map = {
      pending:         { label: "Pending",    color: "#ff9500" },
      invoiced:        { label: "Invoiced",   color: "#00d4ff" },
      paid:            { label: "Paid",       color: "#71ff00" },
      waived:          { label: "Waived",     color: "#888"    },
      active:          { label: "Active",     color: "#71ff00" },
      pending_review:  { label: "In Review",  color: "#ff9500" },
      expired:         { label: "Expired",    color: "#ff4444" },
      cancelled:       { label: "Cancelled",  color: "#888"    },
      overdue:         { label: "Overdue",    color: "#ff4444" },
      pending_payment: { label: "Unpaid",     color: "#ff9500" },
    };
    const s = map[status] || { label: status, color: "#888" };
    return `<span style="background:${s.color}22;color:${s.color};padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700">${s.label}</span>`;
  }

  /* ── Hub badge ── */
  function hubBadge(hub) {
    const rate = _rate(hub);
    return `<span style="background:#ffffff11;color:#ccc;padding:2px 8px;border-radius:20px;font-size:11px">${rate.label}</span>`;
  }

  return {
    PLANS, PLAN_FEATURES, FEATURED_PRICING, AD_CPM,
    estimateCommission, fmtKES, fmtPeriod, statusBadge, hubBadge,
  };
})();
