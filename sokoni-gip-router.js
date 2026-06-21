/* ================================================================
   SOKONI GIP — Route Engine  v1.0.0

   Multi-stop route optimization for the Geo Intelligence Platform.

   Algorithm stack (deterministic, zero AI cost):
   ┌──────────────────────────────────────────────────────────┐
   │  1. OSRM Table API  → real road distance matrix          │
   │  2. Nearest Neighbor → initial route ordering  O(n²)    │
   │  3. 2-opt improvement → swap edges to reduce distance    │
   │  4. OSRM Route API  → actual road geometry per leg       │
   │  5. ETA engine      → per-leg ETA with traffic factor    │
   └──────────────────────────────────────────────────────────┘

   For n ≤ 12 stops: full 2-opt gives near-optimal in <10 ms.
   For n ≤ 50 stops: NN + 2-opt gives ~15% above optimal (fast).
   For n > 50 stops:  geographic cluster then optimize per cluster.

   OSRM public API used (no API key, rate-limited to ~1 req/s).
   Fall back to haversine straight-line if OSRM is unreachable.

   Firestore collection written:
     gipRoutes/{routeId}  — optimized route records

   Exposes: window.SokoniGIPRouter  +  ES default export
================================================================ */

import { db } from './firebase.js';
import {
  doc, setDoc, updateDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import policy, { CONFIDENCE } from './sokoni-ai-policy.js';

/* ── Constants ──────────────────────────────────────────────── */

const OSRM_BASE       = 'https://router.project-osrm.org';
const OSRM_TIMEOUT_MS = 6_000;

/* Average road speed by vehicle type (km/h) — used when OSRM fails */
const ROAD_SPEED = {
  bike:      22,
  rider:     18,
  car:       38,
  van:       32,
  truck:     28,
  ambulance: 55,
};

/* Time-of-day traffic factors (0 = midnight, 23 = 11pm) */
const TRAFFIC_FACTOR = [
  1.0, 1.0, 1.0, 1.0, 1.0, 1.0,   /* 00–05 free flow */
  0.85, 0.75, 0.60, 0.70, 0.80,   /* 06–10 morning rush */
  0.85, 0.90, 0.85, 0.80, 0.75,   /* 11–15 midday */
  0.65, 0.55, 0.65, 0.80, 0.88,   /* 16–20 evening rush */
  0.92, 0.96, 1.0,                 /* 21–23 light traffic */
];

/* ── Private helpers ────────────────────────────────────────── */

function _haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Estimated travel time in minutes applying traffic factor */
function _etaMin(distKm, vehicleType, hour = new Date().getHours()) {
  const speed  = ROAD_SPEED[vehicleType] ?? 35;
  const factor = TRAFFIC_FACTOR[hour] ?? 0.85;
  return Math.ceil((distKm / (speed * factor)) * 60) + 1;
}

function _routeId() {
  return 'RT-' + Date.now().toString(36).toUpperCase() + '-' +
         Math.random().toString(36).slice(2, 5).toUpperCase();
}

async function _fetchWithTimeout(url, ms = OSRM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

/* ── Matrix building ────────────────────────────────────────── */

/**
 * Build a distance matrix via OSRM Table API.
 * Returns { distKm: number[][], durationMin: number[][] }
 * Falls back to haversine if OSRM fails.
 * NOTE: OSRM coordinates are lng,lat (reversed from Leaflet lat,lng).
 */
async function _buildMatrix(stops) {
  const n = stops.length;

  /* Try OSRM Table */
  try {
    const coords = stops.map(s => `${s.lng},${s.lat}`).join(';');
    const url    = `${OSRM_BASE}/table/v1/driving/${coords}?annotations=duration,distance`;
    const res    = await _fetchWithTimeout(url);
    if (!res.ok) throw new Error('OSRM table ' + res.status);
    const data   = await res.json();
    if (data.code !== 'Ok') throw new Error('OSRM code: ' + data.code);

    /* OSRM returns durations in seconds, distances in metres */
    const distKm    = data.distances.map(row => row.map(m => m / 1000));
    const durationMin = data.durations.map(row => row.map(s => Math.ceil(s / 60)));
    return { distKm, durationMin, source: 'osrm' };
  } catch (e) {
    console.warn('[GIPRouter] OSRM table failed, using haversine:', e.message);
  }

  /* Haversine fallback */
  const hour = new Date().getHours();
  const distKm = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (__, j) =>
      i === j ? 0 : _haversineKm(stops[i].lat, stops[i].lng, stops[j].lat, stops[j].lng)
    )
  );
  const durationMin = distKm.map(row => row.map(d => _etaMin(d, 'car', hour)));
  return { distKm, durationMin, source: 'haversine' };
}

/* ── Nearest Neighbor heuristic ─────────────────────────────── */

function _nearestNeighbor(n, distKm, startIdx = 0) {
  const visited = new Set([startIdx]);
  const order   = [startIdx];
  let   current = startIdx;

  while (visited.size < n) {
    let best = -1, bestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (!visited.has(j) && distKm[current][j] < bestDist) {
        best = j; bestDist = distKm[current][j];
      }
    }
    visited.add(best);
    order.push(best);
    current = best;
  }
  return order;
}

/* ── 2-opt improvement ──────────────────────────────────────── */

function _totalDist(order, dist) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) {
    total += dist[order[i]][order[i + 1]];
  }
  return total;
}

/**
 * 2-opt: iteratively try reversing sub-segments to reduce total distance.
 * fixedStart: index 0 is locked (depot / pickup point).
 * openRoute:  no return to start (delivery = open route).
 */
function _twoOpt(order, dist, { fixedStart = true, maxIterations = 40 } = {}) {
  const n        = order.length;
  const startIdx = fixedStart ? 1 : 0;   /* Don't swap the first stop */

  let improved = true;
  let iter     = 0;

  while (improved && iter < maxIterations) {
    improved = false;
    iter++;

    for (let i = startIdx; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        /* Open route: last segment cost is 0 (no return to depot) */
        const d_ij  = dist[order[i - 1 >= 0 ? i - 1 : 0]][order[i]];
        const d_jj1 = j + 1 < n ? dist[order[j]][order[j + 1]] : 0;
        const d_ij1 = dist[order[i - 1 >= 0 ? i - 1 : 0]][order[j]];
        const d_ij2 = j + 1 < n ? dist[order[i]][order[j + 1]] : 0;

        if (d_ij1 + d_ij2 < d_ij + d_jj1 - 1e-6) {
          /* Reverse segment [i..j] */
          const seg = order.slice(i, j + 1).reverse();
          order.splice(i, j - i + 1, ...seg);
          improved = true;
        }
      }
    }
  }

  return order;
}

/* ── Geographic clustering (for n > 30 stops) ──────────────── */

function _clusterStops(stops, k) {
  /* Simple k-means with random seed centroids */
  if (stops.length <= k) return stops.map((_, i) => [i]);

  /* Seed centroids evenly from sorted lat */
  const sorted    = [...stops.keys()].sort((a, b) => stops[a].lat - stops[b].lat);
  let centroids   = [];
  for (let i = 0; i < k; i++) {
    const idx = Math.round((i / k) * sorted.length);
    centroids.push({ lat: stops[sorted[idx]].lat, lng: stops[sorted[idx]].lng });
  }

  let assignments = new Array(stops.length).fill(0);
  const MAX_ITER = 20;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    /* Assign each stop to nearest centroid */
    let changed = false;
    stops.forEach((s, i) => {
      let bestC = 0, bestD = Infinity;
      centroids.forEach((c, ci) => {
        const d = _haversineKm(s.lat, s.lng, c.lat, c.lng);
        if (d < bestD) { bestC = ci; bestD = d; }
      });
      if (assignments[i] !== bestC) { assignments[i] = bestC; changed = true; }
    });
    if (!changed) break;

    /* Recompute centroids */
    centroids = centroids.map((_, ci) => {
      const members = stops.filter((__, i) => assignments[i] === ci);
      if (!members.length) return centroids[ci];
      return {
        lat: members.reduce((s, p) => s + p.lat, 0) / members.length,
        lng: members.reduce((s, p) => s + p.lng, 0) / members.length,
      };
    });
  }

  /* Group indices by cluster */
  const clusters = Array.from({ length: k }, () => []);
  assignments.forEach((c, i) => clusters[c].push(i));
  return clusters.filter(c => c.length > 0);
}

/* ── OSRM road geometry for one leg ─────────────────────────── */

async function _legGeometry(fromStop, toStop) {
  try {
    const coords = `${fromStop.lng},${fromStop.lat};${toStop.lng},${toStop.lat}`;
    const url    = `${OSRM_BASE}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    const res    = await _fetchWithTimeout(url);
    if (!res.ok) throw new Error('OSRM route ' + res.status);
    const data   = await res.json();
    if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error('No route');

    const route = data.routes[0];
    return {
      geometry:     route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      distanceKm:   Math.round(route.distance / 10) / 100,
      durationMin:  Math.ceil(route.duration / 60),
      source:       'osrm',
    };
  } catch (e) {
    /* Straight-line fallback */
    const dist = _haversineKm(fromStop.lat, fromStop.lng, toStop.lat, toStop.lng);
    return {
      geometry:    [[fromStop.lat, fromStop.lng], [toStop.lat, toStop.lng]],
      distanceKm:  Math.round(dist * 100) / 100,
      durationMin: _etaMin(dist, 'car'),
      source:      'haversine',
    };
  }
}

/* ══════════════════════════════════════════════════════════════
   RouteEngine (main export)
══════════════════════════════════════════════════════════════ */

export default class RouteEngine {

  /**
   * Optimize and fetch full road geometry for a multi-stop route.
   *
   * @param {object[]} stops   — array of {lat, lng, label?, id?, priority?}
   * @param {object}   options
   *   @param {boolean} options.fixedStart    — lock first stop (pickup/depot). Default true.
   *   @param {boolean} options.fixedEnd      — lock last stop. Default false.
   *   @param {string}  options.vehicleType   — 'bike'|'car'|'van'|'truck'. Default 'bike'.
   *   @param {boolean} options.fetchGeometry — fetch OSRM road lines. Default true.
   *   @param {string}  options.module        — calling module name. Default 'delivery'.
   *   @param {boolean} options.persist       — save to Firestore gipRoutes. Default false.
   *
   * @returns {Promise<RouteResult>}
   */
  async optimize(stops, options = {}) {
    if (!Array.isArray(stops) || stops.length < 2) {
      throw new Error('[GIPRouter] At least 2 stops required');
    }

    /* Validate all coordinates */
    stops.forEach((s, i) => {
      if (typeof s.lat !== 'number' || typeof s.lng !== 'number') {
        throw new Error(`[GIPRouter] Invalid coordinate at stop ${i}`);
      }
    });

    const {
      fixedStart    = true,
      vehicleType   = 'bike',
      fetchGeometry = true,
      module        = 'delivery',
      persist       = false,
    } = options;

    const n = stops.length;

    /* ── Step 1: Distance matrix ── */
    const { distKm, durationMin, source: matrixSource } = await _buildMatrix(stops);

    /* ── Step 2: Optimize order ── */
    let optimalOrder;
    if (n <= 2) {
      optimalOrder = [0, 1];
    } else if (n <= 30) {
      /* Small/medium: NN + 2-opt */
      const nnOrder = _nearestNeighbor(n, distKm, 0);
      optimalOrder  = _twoOpt(nnOrder, distKm, { fixedStart });
    } else {
      /* Large: cluster → NN+2-opt within each cluster → join clusters */
      const k        = Math.max(2, Math.ceil(n / 12));
      const clusters = _clusterStops(stops, k);

      /* Determine cluster visit order by NN on cluster centroids */
      const centroids = clusters.map(c => {
        const lats = c.map(i => stops[i].lat);
        const lngs = c.map(i => stops[i].lng);
        return { lat: lats.reduce((a,b)=>a+b)/lats.length, lng: lngs.reduce((a,b)=>a+b)/lngs.length };
      });
      const centDist = clusters.map((_, ci) =>
        clusters.map((__, cj) =>
          _haversineKm(centroids[ci].lat, centroids[ci].lng, centroids[cj].lat, centroids[cj].lng)
        )
      );
      const clusterOrder = _nearestNeighbor(k, centDist, 0);

      /* Optimize within each cluster and concatenate */
      optimalOrder = [];
      clusterOrder.forEach(ci => {
        const cl = clusters[ci];
        if (cl.length === 1) { optimalOrder.push(cl[0]); return; }
        /* Local sub-matrix */
        const subDist = cl.map(a => cl.map(b => distKm[a][b]));
        const subOrder = _nearestNeighbor(cl.length, subDist, 0);
        const opt2 = _twoOpt(subOrder, subDist, { fixedStart: false });
        opt2.forEach(idx => optimalOrder.push(cl[idx]));
      });
    }

    /* ── Step 3: Build ordered stops ── */
    const orderedStops = optimalOrder.map(i => stops[i]);

    /* ── Step 4: Road geometry per leg ── */
    const legs = [];
    let totalDistKm   = 0;
    let totalDurationMin = 0;
    let cumulativeETA = 0;
    const now = new Date();

    for (let i = 0; i < orderedStops.length - 1; i++) {
      const from = orderedStops[i];
      const to   = orderedStops[i + 1];
      const leg  = fetchGeometry
        ? await _legGeometry(from, to)
        : {
            geometry:    [[from.lat, from.lng], [to.lat, to.lng]],
            distanceKm:  distKm[optimalOrder[i]][optimalOrder[i + 1]],
            durationMin: durationMin[optimalOrder[i]][optimalOrder[i + 1]],
            source:      matrixSource,
          };

      /* Apply traffic factor to OSRM duration */
      const hour    = (now.getHours() + Math.floor(cumulativeETA / 60)) % 24;
      const traffic = TRAFFIC_FACTOR[hour] ?? 0.85;
      const adjMin  = Math.ceil(leg.durationMin / traffic);

      cumulativeETA  += adjMin;
      totalDistKm    += leg.distanceKm;
      totalDurationMin += adjMin;

      legs.push({
        from: { ...from, stopIndex: i },
        to:   { ...to,   stopIndex: i + 1 },
        ...leg,
        durationMin:     adjMin,
        trafficFactor:   traffic,
        cumulativeETA,
        etaTimestamp:    new Date(now.getTime() + cumulativeETA * 60_000).toISOString(),
      });
    }

    /* ── Confidence score ── */
    /* Higher distance = more uncertainty; matrix source haversine = lower confidence */
    const baseConf = matrixSource === 'osrm' ? 0.85 : 0.65;
    const distPenalty = Math.min(0.25, totalDistKm / 200);
    const confidence = Math.round((baseConf - distPenalty) * 100) / 100;

    const result = {
      id:              _routeId(),
      module,
      vehicleType,
      originalOrder:   stops,
      optimizedOrder:  orderedStops,
      stopCount:       orderedStops.length,
      legs,
      totalDistKm:     Math.round(totalDistKm * 100) / 100,
      totalDurationMin,
      estimatedETA:    new Date(now.getTime() + totalDurationMin * 60_000).toISOString(),
      confidence,
      matrixSource,
      createdAt:       now.toISOString(),
    };

    /* ── Persist to Firestore ── */
    if (persist) {
      try {
        await setDoc(doc(db, 'gipRoutes', result.id), {
          ...result,
          /* Strip geometry arrays for Firestore (too large — store separately if needed) */
          legs:      legs.map(l => ({ ...l, geometry: undefined })),
          createdAt: serverTimestamp(),
        });
      } catch (e) {
        console.warn('[GIPRouter] persist:', e.message);
      }
    }

    return result;
  }

  /**
   * Simple A→B directions (two stops only).
   */
  async directions(fromLat, fromLng, toLat, toLng, vehicleType = 'bike') {
    return this.optimize(
      [{ lat: fromLat, lng: fromLng }, { lat: toLat, lng: toLng }],
      { fixedStart: true, vehicleType, fetchGeometry: true }
    );
  }

  /**
   * Build a full distance + duration matrix between multiple origins and destinations.
   * Useful for "which driver is closest to this pickup?" — avoid calling this with n > 20.
   */
  async distanceMatrix(origins, destinations) {
    const all    = [...origins, ...destinations];
    const { distKm, durationMin, source } = await _buildMatrix(all);
    const no     = origins.length;
    const nd     = destinations.length;

    return {
      distKm:      origins.map((_, i) => destinations.map((__, j) => distKm[i][no + j])),
      durationMin: origins.map((_, i) => destinations.map((__, j) => durationMin[i][no + j])),
      source,
    };
  }

  /**
   * Quick ETA estimate without OSRM (instant, good enough for pre-dispatch estimates).
   */
  quickETA(fromLat, fromLng, toLat, toLng, vehicleType = 'bike', hourOverride = null) {
    const dist  = _haversineKm(fromLat, fromLng, toLat, toLng);
    const hour  = hourOverride ?? new Date().getHours();
    const speed = ROAD_SPEED[vehicleType] ?? 35;
    const factor= TRAFFIC_FACTOR[hour] ?? 0.85;
    const durationMin = Math.ceil((dist / (speed * factor)) * 60);

    /* AI Policy: quickETA uses haversine (straight-line) distance, not real roads.
       It is a CALCULATED estimate — transparent about using straight-line fallback. */
    return {
      distanceKm:  Math.round(dist * 100) / 100,
      durationMin,
      eta:         new Date(Date.now() + durationMin * 60_000).toISOString(),
      trafficFactor: factor,
      _policy: policy.calculated(durationMin, {
        formula: `Haversine distance (${Math.round(dist * 100) / 100} km) ÷ `
               + `${vehicleType} speed (${speed} km/h) × traffic factor (${factor}) `
               + `— straight-line estimate, not actual road route`,
      }),
    };
  }

  /**
   * Draw an optimized route on a Leaflet map.
   * @param {L.Map}    map        — Leaflet map instance
   * @param {object}   routeResult — result from optimize()
   * @param {object}   [styles]
   */
  renderOnMap(map, routeResult, styles = {}) {
    if (!map || !routeResult?.legs) return null;

    const layers = [];
    const colors = ['#71ff00', '#00aaff', '#ffc107', '#ff9800', '#ff4444', '#cc00ff'];

    routeResult.legs.forEach((leg, i) => {
      const color = colors[i % colors.length];

      /* Road geometry polyline */
      if (leg.geometry?.length > 1) {
        const line = L.polyline(leg.geometry, {
          color:   styles.color   ?? color,
          weight:  styles.weight  ?? 4,
          opacity: styles.opacity ?? 0.85,
          dashArray: i === 0 ? null : '10, 6',
        }).addTo(map);
        layers.push(line);
      }

      /* Stop marker */
      const stop = leg.from;
      const marker = L.marker([stop.lat, stop.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="
            width:28px;height:28px;border-radius:50%;
            background:rgba(8,8,8,0.9);border:2px solid ${color};
            display:flex;align-items:center;justify-content:center;
            font-size:11px;font-weight:900;color:${color};
          ">${i + 1}</div>`,
          iconSize:   [28, 28],
          iconAnchor: [14, 14],
        }),
      }).bindPopup(`
        <div style="font-family:system-ui;color:white;min-width:180px;">
          <div style="font-weight:900;margin-bottom:6px;">Stop ${i + 1}${stop.label ? ` — ${stop.label}` : ''}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.5);">ETA: ~${leg.cumulativeETA} min · ${leg.distanceKm} km</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.5);">Arrives: ${new Date(leg.etaTimestamp).toLocaleTimeString()}</div>
        </div>
      `).addTo(map);
      layers.push(marker);
    });

    /* Final destination marker */
    const last = routeResult.orderedStops?.[routeResult.orderedStops.length - 1]
              ?? routeResult.optimizedOrder?.[routeResult.optimizedOrder.length - 1];
    if (last) {
      const destMarker = L.marker([last.lat, last.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="
            width:34px;height:34px;border-radius:50%;
            background:rgba(113,255,0,0.18);border:2.5px solid #71ff00;
            display:flex;align-items:center;justify-content:center;font-size:18px;
            box-shadow:0 0 12px rgba(113,255,0,0.5);">🏁</div>`,
          iconSize:   [34, 34],
          iconAnchor: [17, 17],
        }),
      }).bindPopup('<div style="font-family:system-ui;color:white;font-weight:900;">Final Destination</div>')
        .addTo(map);
      layers.push(destMarker);
    }

    /* Fit bounds */
    const allPoints = routeResult.legs.flatMap(l => l.geometry ?? []);
    if (allPoints.length) {
      map.fitBounds(L.latLngBounds(allPoints), { padding: [40, 40], maxZoom: 15 });
    }

    /* Return cleanup function */
    return () => layers.forEach(l => map.removeLayer(l));
  }

  /* ── Traffic factor helper ── */
  static trafficFactor(hour = new Date().getHours()) {
    return TRAFFIC_FACTOR[hour] ?? 0.85;
  }

  static roadSpeed(vehicleType) {
    return ROAD_SPEED[vehicleType] ?? 35;
  }
}

if (typeof window !== 'undefined') window.SokoniGIPRouter = RouteEngine;
