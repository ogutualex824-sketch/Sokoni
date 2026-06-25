#!/usr/bin/env node
/**
 * SOKONI Cloudflare Traffic Weight Controller
 *
 * Updates a Cloudflare Load Balancing pool weight for canary deployments.
 * Falls back gracefully if no load balancer is configured — canary
 * health observation still runs; only traffic splitting is skipped.
 *
 * Usage:
 *   node scripts/deploy/cloudflare-traffic.js --weight=1
 *   node scripts/deploy/cloudflare-traffic.js --weight=100
 */
'use strict';

const https = require('https');

const CF_TOKEN   = process.env.CF_API_TOKEN;
const ZONE_ID    = process.env.CF_ZONE_ID;
const LB_NAME    = process.env.CF_LB_NAME    || 'sokoni-canary';
const POOL_CANARY= process.env.CF_POOL_CANARY || 'canary';

if (!CF_TOKEN || !ZONE_ID) {
  console.log('ℹ️  CF_API_TOKEN or CF_ZONE_ID not set — traffic split skipped');
  process.exit(0);
}

const weight = parseInt((process.argv.find(a => a.startsWith('--weight=')) || '--weight=100').split('=')[1], 10);

function cfRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path:     `/client/v4${path}`,
      method,
      headers: {
        Authorization:  `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  /* 1. Find load balancer by name */
  const lbList = await cfRequest('GET', `/zones/${ZONE_ID}/load_balancers`);
  if (!lbList.body?.success || !lbList.body.result?.length) {
    console.log(`ℹ️  No load balancers found in zone ${ZONE_ID} — traffic split skipped`);
    process.exit(0);
  }

  const lb = lbList.body.result.find(l => l.name.includes(LB_NAME) || l.name.includes('canary'));
  if (!lb) {
    console.log(`ℹ️  Load balancer "${LB_NAME}" not found — traffic split skipped`);
    process.exit(0);
  }

  /* 2. Find canary pool */
  const pools = lb.pools || [];
  if (!pools.length) {
    console.log('ℹ️  No pools on load balancer — skipped');
    process.exit(0);
  }

  /* 3. Update pool weights — canary gets `weight/100`, primary gets `(100-weight)/100` */
  const canaryWeight  = weight / 100;
  const primaryWeight = (100 - weight) / 100;

  const updatedPools = pools.map(poolId => {
    if (typeof poolId === 'string') {
      /* Simple pool list — wrap with weight */
      return { pool: poolId, weight: poolId.includes(POOL_CANARY) ? canaryWeight : primaryWeight };
    }
    return { ...poolId, weight: poolId.pool?.includes(POOL_CANARY) ? canaryWeight : primaryWeight };
  });

  const patch = await cfRequest('PATCH', `/zones/${ZONE_ID}/load_balancers/${lb.id}`, {
    default_pools: updatedPools.map(p => typeof p === 'string' ? p : p.pool),
    pool_weights: Object.fromEntries(updatedPools.map(p => [
      typeof p === 'string' ? p : p.pool,
      typeof p === 'string' ? 1 : p.weight,
    ])),
  });

  if (patch.body?.success) {
    console.log(`✅  Cloudflare traffic split updated — canary: ${weight}%, primary: ${100 - weight}%`);
  } else {
    console.warn(`⚠️  Cloudflare update failed: ${JSON.stringify(patch.body?.errors || patch.body)}`);
    /* Non-fatal — canary health observation will still run */
    process.exit(0);
  }
}

run().catch(err => {
  /* Never block the deploy pipeline on Cloudflare API errors */
  console.warn(`⚠️  Cloudflare traffic script error: ${err.message}`);
  process.exit(0);
});
