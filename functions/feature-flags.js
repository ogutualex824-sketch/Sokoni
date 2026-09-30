/**
 * SOKONI Feature Flags — Server-Side (Cloud Functions)
 * Reads Firebase Remote Config and provides a typed accessor for Cloud Functions.
 */
'use strict';

const admin = require('firebase-admin');

/* Safe defaults — mirrors sokoni-flags.js client defaults */
const DEFAULTS = {
  new_checkout_flow:       false,
  search_v2_typesense:     true,
  search_algolia_fallback: true,
  ai_assistant:            true,
  ai_moderation:           true,
  maintenance_mode:        false,
  read_only_mode:          false,
  canary_new_functions:    false,
  mpesa_express_v3:        true,
  card_payments:           true,
  wallet_topup:            true,
  real_time_tracking:      true,
  smartpos_offline_mode:   true,
};

let _cache     = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000; /* 1 minute server-side cache */

async function getFlags() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  try {
    const rc = admin.remoteConfig();
    const template = await rc.getTemplate();
    const params   = template.parameters || {};
    const flags    = { ...DEFAULTS };

    Object.entries(params).forEach(([key, param]) => {
      const val = param.defaultValue?.value;
      if (val === undefined) return;
      try { flags[key] = JSON.parse(val); }
      catch { flags[key] = val; }
    });

    _cache     = flags;
    _cacheTime = Date.now();
    return flags;
  } catch {
    /* Remote Config unavailable — return safe defaults */
    return { ...DEFAULTS };
  }
}

async function getFlag(key) {
  const flags = await getFlags();
  return key in flags ? flags[key] : (DEFAULTS[key] ?? false);
}

async function isMaintenanceMode() { return (await getFlag('maintenance_mode')) === true; }
async function isReadOnly()        { return (await getFlag('read_only_mode'))   === true; }

/* Middleware helper: throw if maintenance mode is on */
async function assertNotMaintenance() {
  if (await isMaintenanceMode()) {
    const { HttpsError } = require('firebase-functions/v2/https');
    throw new HttpsError('unavailable', 'SOKONI is under scheduled maintenance. Please try again shortly.');
  }
}

module.exports = { getFlags, getFlag, isMaintenanceMode, isReadOnly, assertNotMaintenance };
