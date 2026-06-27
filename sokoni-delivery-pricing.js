/* ================================================================
   SOKONI — Intelligent Delivery Pricing Engine  v2.0
   Dynamic, rider-first delivery cost calculation.

   Features:
   • Distance + time + weight + size + vehicle-type pricing
   • Peak-hour and demand surge multipliers
   • Rural delivery surcharge
   • Rider payout protection (minimum earnings guarantee)
   • Marketplace subsidy support
   • Transparent breakdown with human-readable reasons
   • HTML breakdown renderer for UI injection

   Usage (browser):
     const result = SokoniDeliveryPricing.calculate({ ... });
     document.getElementById('fee').innerHTML =
       SokoniDeliveryPricing.renderBreakdown(result);

   Usage (Cloud Functions via require):
     const { calculate } = require('./sokoni-delivery-pricing');

   Exposes: window.SokoniDeliveryPricing
================================================================ */
(function (g) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     PRICING CONFIGURATION  — all monetary values in KES
  ──────────────────────────────────────────────────────────────*/
  var CONFIG = {

    vehicles: {
      moto:    { label:'Motorcycle', icon:'🏍️', base:100, perKm:18, perMin:0.80, maxWeightKg:15   },
      bicycle: { label:'Bicycle',    icon:'🚲', base: 60, perKm:10, perMin:0.45, maxWeightKg: 8   },
      car:     { label:'Car',        icon:'🚗', base:220, perKm:38, perMin:1.00, maxWeightKg:50   },
      van:     { label:'Van',        icon:'🚐', base:450, perKm:58, perMin:1.60, maxWeightKg:200  },
      truck:   { label:'Truck',      icon:'🚛', base:800, perKm:85, perMin:2.00, maxWeightKg:1000 },
      tuktuk:  { label:'Tuk-Tuk',   icon:'🛺', base:130, perKm:22, perMin:0.85, maxWeightKg:30   },
      ebike:   { label:'E-Bike',     icon:'⚡', base: 70, perKm:12, perMin:0.50, maxWeightKg:12   },
    },

    /* Weight tiers — flat surcharge added after multipliers */
    weightBreaks: [
      { maxKg:   1, surcharge:    0, label:'Light (≤1 kg)'        },
      { maxKg:   5, surcharge:   30, label:'Standard (1–5 kg)'    },
      { maxKg:  15, surcharge:   80, label:'Heavy (5–15 kg)'      },
      { maxKg:  50, surcharge:  200, label:'Very heavy (15–50 kg)'},
      { maxKg: 200, surcharge:  500, label:'Industrial (50–200 kg)'},
      { maxKg: Infinity, surcharge:1000, label:'Freight (>200 kg)' },
    ],

    /* Parcel size — flat surcharge added after multipliers */
    sizeSurcharges: {
      small:       { label:'Small (bag-sized)',    surcharge:   0 },
      medium:      { label:'Medium (shoebox)',      surcharge:  25 },
      large:       { label:'Large (luggage)',       surcharge:  70 },
      extra_large: { label:'Extra-large / bulky',   surcharge: 200 },
    },

    /* Speed tier — multiplier on variable components */
    speedMultipliers: {
      express:   { label:'Express (1–2 hrs)',   multiplier:1.55, icon:'⚡'  },
      same_day:  { label:'Same-Day (4–8 hrs)',  multiplier:1.00, icon:'📅'  },
      scheduled: { label:'Scheduled',            multiplier:0.85, icon:'🗓️' },
    },

    /* Peak-hour windows (local clock hour + decimal minute) */
    peakWindows: [
      { startH: 7,  endH:  9, multiplier:1.30, label:'Morning peak (7–9 AM)'   },
      { startH:12,  endH: 13, multiplier:1.15, label:'Lunch rush (12–1 PM)'    },
      { startH:17,  endH: 20, multiplier:1.35, label:'Evening peak (5–8 PM)'   },
    ],

    /* Rider protection — never compromise rider earnings */
    rider: {
      shareTarget:  0.82,  /* target % to rider                   */
      shareMin:     0.75,  /* floor — platform never goes below   */
      minPayoutKES: 180,   /* absolute floor per trip (KES)       */
      minPerKm:      12,   /* minimum KES per road km             */
      minPerMin:      0.5, /* minimum KES per travel minute       */
    },

    /* Platform subsidy cap (% of customer fee that platform will absorb) */
    platform: { maxSubsidyPct: 0.40 },

    /* Misc surcharges */
    ruralSurchargeKES:       60,
    waitTimeSurchargePerMin:  3,

    /* Demand multiplier clamp */
    demandMin: 1.0,
    demandMax: 2.0,
  };

  /* ─────────────────────────────────────────────────────────────
     HELPERS
  ──────────────────────────────────────────────────────────────*/
  function _weightSurcharge(kg) {
    for (var i = 0; i < CONFIG.weightBreaks.length; i++) {
      if (kg <= CONFIG.weightBreaks[i].maxKg) return CONFIG.weightBreaks[i];
    }
    return CONFIG.weightBreaks[CONFIG.weightBreaks.length - 1];
  }

  function _peakInfo(tsMs) {
    var d = new Date(tsMs || Date.now());
    var h = d.getHours() + d.getMinutes() / 60;
    for (var i = 0; i < CONFIG.peakWindows.length; i++) {
      var w = CONFIG.peakWindows[i];
      if (h >= w.startH && h < w.endH) return { multiplier:w.multiplier, label:w.label };
    }
    return { multiplier:1.0, label:null };
  }

  /* ─────────────────────────────────────────────────────────────
     MAIN CALCULATION

     opts = {
       vehicleType,       // 'moto'|'bicycle'|'car'|'van'|'truck'|'tuktuk'|'ebike'
       distanceKm,        // road distance (OSRM preferred, haversine×1.35 fallback)
       durationMin,       // estimated travel time in minutes
       weightKg,          // parcel weight   (default 1)
       parcelSize,        // 'small'|'medium'|'large'|'extra_large'  (default 'small')
       speedTier,         // 'express'|'same_day'|'scheduled'
       demandMultiplier,  // 1.0–2.0  (from backend demand signal; default 1.0)
       isRural,           // boolean  (peri-urban / outside Nairobi)
       waitTimeMin,       // minutes waiting at pickup  (default 0)
       timestamp,         // ms — for peak-hour detection  (default Date.now())
       subsidyKES,        // SOKONI subsidy amount — reduces customer fee
     }

     Returns: PricingResult {
       customerPaysFee,   // KES — what customer actually pays (post-subsidy)
       customerFee,       // KES — full fee before subsidy
       riderPayout,       // KES — rider earnings (guaranteed ≥ minimum)
       platformCut,       // KES — SOKONI margin
       subsidyKES,        // KES — applied subsidy
       riderSharePct,     // number — e.g. 82
       reasons,           // string[]
       primaryReason,     // string | null
       isPeakHour, isSurging, meetsRiderMinimum, riderMinEarning,
       vehicleType, vehicleLabel, vehicleIcon,
       components: { baseFee, distanceFee, timeFee, weightFee, sizeFee, ... }
     }
  ──────────────────────────────────────────────────────────────*/
  function calculate(opts) {
    opts = opts || {};
    var vehicleType     = opts.vehicleType       || 'moto';
    var distanceKm      = Math.max(0.3, Number(opts.distanceKm  || 3));
    var durationMin     = Math.max(1,   Number(opts.durationMin || 15));
    var weightKg        = Math.max(0,   Number(opts.weightKg    || 1));
    var parcelSize      = opts.parcelSize         || 'small';
    var speedTier       = opts.speedTier          || 'same_day';
    var demandMult      = Number(opts.demandMultiplier || 1.0);
    var isRural         = !!opts.isRural;
    var waitTimeMin     = Math.max(0, Number(opts.waitTimeMin || 0));
    var timestamp       = opts.timestamp          || Date.now();
    var subsidyKES      = Math.max(0, Number(opts.subsidyKES  || 0));

    var vehicle  = CONFIG.vehicles[vehicleType] || CONFIG.vehicles.moto;
    var speed    = CONFIG.speedMultipliers[speedTier] || CONFIG.speedMultipliers.same_day;
    var peak     = _peakInfo(timestamp);
    var weightBk = _weightSurcharge(weightKg);
    var sizeBk   = CONFIG.sizeSurcharges[parcelSize] || CONFIG.sizeSurcharges.small;
    var rCfg     = CONFIG.rider;

    /* ── Component costs (before speed/peak/demand multiplier) ── */
    var baseFee     = vehicle.base;
    var distanceFee = Math.round(distanceKm * vehicle.perKm);
    var timeFee     = Math.round(durationMin * vehicle.perMin);
    var weightFee   = weightBk.surcharge;
    var sizeFee     = sizeBk.surcharge;
    /* Post-multiplier flat additions */
    var waitFee     = Math.round(waitTimeMin * CONFIG.waitTimeSurchargePerMin);
    var ruralFee    = isRural ? CONFIG.ruralSurchargeKES : 0;

    /* ── Clamp demand ── */
    var demand = Math.min(Math.max(demandMult, CONFIG.demandMin), CONFIG.demandMax);

    /* ── Combined multiplier ── */
    var combinedMult = speed.multiplier * peak.multiplier * demand;

    /* ── Raw fee before rider-floor ── */
    var rawFee = Math.round((baseFee + distanceFee + timeFee + weightFee + sizeFee) * combinedMult)
               + waitFee + ruralFee;

    /* ── Rider minimum earnings guarantee ── */
    var riderMinByRoute = Math.round(rCfg.minPerKm * distanceKm + rCfg.minPerMin * durationMin);
    var riderMinEarning = Math.max(rCfg.minPayoutKES, riderMinByRoute);

    /* ── Customer fee must be high enough to honour rider at target share ── */
    var minFeeForRider = Math.ceil(riderMinEarning / rCfg.shareTarget);
    var customerFee    = Math.max(rawFee, minFeeForRider);

    /* ── Apply subsidy ── */
    var maxSubsidy     = Math.round(customerFee * CONFIG.platform.maxSubsidyPct);
    var appliedSubsidy = Math.min(subsidyKES, maxSubsidy);
    var customerPaysFee = Math.max(1, Math.round(customerFee - appliedSubsidy));

    /* ── Rider payout (always ≥ floor, from un-subsidised customerFee) ── */
    var riderPayout   = Math.max(riderMinEarning, Math.round(customerFee * rCfg.shareTarget));
    var platformCut   = customerFee - riderPayout;
    var riderSharePct = Math.round((riderPayout / customerFee) * 100);

    /* ── Human-readable reasons ── */
    var reasons = [];
    if (peak.multiplier > 1)                         reasons.push(peak.label);
    if (demand > 1.2)                                reasons.push('High demand');
    if (speedTier === 'express')                     reasons.push('Express delivery');
    if (distanceKm > 15)                             reasons.push('Long distance');
    if (weightKg > 5)                                reasons.push('Heavy parcel');
    if (parcelSize === 'large' || parcelSize === 'extra_large') reasons.push('Large parcel');
    if (isRural)                                     reasons.push('Rural delivery');
    if (waitTimeMin > 5)                             reasons.push('Waiting time');
    if (customerFee > rawFee)                        reasons.push('Rider fair-pay guarantee');
    if (appliedSubsidy > 0)                          reasons.push('SOKONI subsidy applied');

    return {
      /* Totals */
      customerPaysFee: customerPaysFee,
      customerFee:     customerFee,
      riderPayout:     riderPayout,
      platformCut:     platformCut,
      subsidyKES:      Math.round(appliedSubsidy),
      riderSharePct:   riderSharePct,
      /* Status flags */
      isPeakHour:        peak.multiplier > 1,
      isSurging:         demand > 1.1,
      meetsRiderMinimum: riderPayout >= riderMinEarning,
      riderMinEarning:   riderMinEarning,
      /* Reasons */
      reasons:       reasons,
      primaryReason: reasons[0] || null,
      /* Vehicle meta */
      vehicleType:  vehicleType,
      vehicleLabel: vehicle.label,
      vehicleIcon:  vehicle.icon,
      /* Full breakdown */
      components: {
        baseFee:           baseFee,
        distanceFee:       distanceFee,
        timeFee:           timeFee,
        weightFee:         weightFee,
        sizeFee:           sizeFee,
        waitFee:           waitFee,
        ruralFee:          ruralFee,
        speedMultiplier:   speed.multiplier,
        peakMultiplier:    peak.multiplier,
        demandMultiplier:  demand,
        combinedMultiplier:combinedMult,
        rawFee:            rawFee,
        peakLabel:         peak.label,
        weightLabel:       weightBk.label,
        sizeLabel:         sizeBk.label,
        speedLabel:        speed.label,
      },
    };
  }

  /* ─────────────────────────────────────────────────────────────
     HTML BREAKDOWN RENDERER
     Returns an HTML string suitable for innerHTML injection.
     All values are numbers (no user-controlled strings) — safe.
  ──────────────────────────────────────────────────────────────*/
  function renderBreakdown(result) {
    var c   = result.components;
    var out = [];

    function row(label, val, highlight) {
      var color = highlight ? '#71ff00' : 'rgba(255,255,255,0.55)';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px;">'
           + '<span style="color:rgba(255,255,255,0.38);">' + label + '</span>'
           + '<span style="color:' + color + ';font-weight:700;">KES ' + Math.abs(val).toLocaleString() + '</span>'
           + '</div>';
    }

    out.push(row(result.vehicleIcon + ' ' + result.vehicleLabel + ' (base)', c.baseFee));
    out.push(row('Distance fee', c.distanceFee));
    if (c.timeFee > 0) out.push(row('Time fee', c.timeFee));
    if (c.weightFee > 0) out.push(row('Weight (' + c.weightLabel + ')', c.weightFee));
    if (c.sizeFee > 0) out.push(row('Size (' + c.sizeLabel + ')', c.sizeFee));
    if (c.waitFee > 0) out.push(row('Waiting fee', c.waitFee));
    if (c.ruralFee > 0) out.push(row('Rural delivery', c.ruralFee));

    /* Multiplier row */
    if (Math.abs(c.combinedMultiplier - 1.0) > 0.005) {
      var pct  = Math.round((c.combinedMultiplier - 1) * 100);
      var sign = pct >= 0 ? '+' : '';
      var tags = [c.speedLabel];
      if (c.peakLabel)              tags.push(c.peakLabel);
      if (c.demandMultiplier > 1.1) tags.push('High demand');
      out.push(
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:11px;">'
        + '<span style="color:rgba(251,191,36,0.7);">Multiplier (' + tags.join(' · ') + ')</span>'
        + '<span style="color:rgba(251,191,36,0.9);font-weight:700;">' + sign + pct + '%</span>'
        + '</div>'
      );
    }

    /* Divider */
    out.push('<div style="border-top:1px solid rgba(255,255,255,0.07);margin:6px 0;"></div>');

    if (result.subsidyKES > 0) {
      out.push(row('Full fee', result.customerFee));
      out.push(
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px;">'
        + '<span style="color:rgba(113,255,0,0.55);">SOKONI subsidy</span>'
        + '<span style="color:rgba(113,255,0,0.85);font-weight:700;">− KES ' + result.subsidyKES.toLocaleString() + '</span>'
        + '</div>'
      );
    }

    out.push(row('Delivery fee', result.customerPaysFee, true));

    /* Surge / reason tags */
    if (result.reasons.length) {
      var tags2 = result.reasons.map(function (r) {
        return '<span style="display:inline-block;background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.22);'
             + 'border-radius:7px;padding:2px 7px;font-size:10px;color:rgba(251,191,36,0.85);font-weight:700;margin:2px 3px 0 0;">'
             + r + '</span>';
      }).join('');
      out.push('<div style="padding-top:5px;">' + tags2 + '</div>');
    }

    return out.join('');
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API
  ──────────────────────────────────────────────────────────────*/
  var SokoniDeliveryPricing = {
    calculate:       calculate,
    renderBreakdown: renderBreakdown,
    CONFIG:          CONFIG,
  };

  g.SokoniDeliveryPricing = SokoniDeliveryPricing;
  /* Cloud Function / Node require() compatibility */
  if (typeof module !== 'undefined') module.exports = SokoniDeliveryPricing;

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
