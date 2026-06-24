#!/usr/bin/env node
/* ============================================================
   SOKONI Monitoring Setup Script  v1.0

   Run once to bootstrap Google Cloud Monitoring alerts.
   Prerequisites:
     gcloud auth application-default login
     gcloud config set project sokoni-aeb26

   Usage:
     node scripts/setup-monitoring.js           (create channel + apply alerts)
     node scripts/setup-monitoring.js --channel-only  (create channel only)
     node scripts/setup-monitoring.js --alerts-only   (apply alerts with existing channel ID)

   The channel ID is saved into monitoring/alerts.json automatically
   so subsequent runs are idempotent.
============================================================ */
"use strict";

const { execSync, spawnSync } = require("child_process");
const fs   = require("fs");
const path = require("path");

const ROOT        = path.resolve(__dirname, "..");
const ALERTS_PATH = path.join(ROOT, "monitoring", "alerts.json");
const PROJECT     = "sokoni-aeb26";
const ALERT_EMAIL = "devops@mysokoni.co.ke";

const ARGS       = process.argv.slice(2);
const ONLY_CHAN  = ARGS.includes("--channel-only");
const ONLY_ALERT = ARGS.includes("--alerts-only");

/* ── Colour ── */
const isTTY = process.stdout.isTTY;
const GRN = isTTY ? "\x1b[32m" : ""; const RED = isTTY ? "\x1b[31m" : "";
const YLW = isTTY ? "\x1b[33m" : ""; const RST = isTTY ? "\x1b[0m"  : "";
const DIM = isTTY ? "\x1b[2m"  : "";

console.log(`\n${DIM}══════════════════════════════════════════════${RST}`);
console.log(`  SOKONI Monitoring Setup`);
console.log(`  Project: ${PROJECT}`);
console.log(`${DIM}══════════════════════════════════════════════${RST}\n`);

/* ── Step 0: Check gcloud is available ── */
const gcloudCheck = spawnSync("gcloud", ["version"], { encoding: "utf8" });
if (gcloudCheck.status !== 0) {
  console.error(`${RED}❌  gcloud CLI not found. Install from https://cloud.google.com/sdk/docs/install${RST}`);
  process.exit(1);
}
console.log(`${GRN}✔${RST}  gcloud CLI available`);

/* ── Step 1: Load alerts config ── */
let config;
try {
  config = JSON.parse(fs.readFileSync(ALERTS_PATH, "utf8"));
} catch (e) {
  console.error(`${RED}❌  Cannot read monitoring/alerts.json: ${e.message}${RST}`);
  process.exit(1);
}

const envChannelId = process.env.NOTIFICATION_CHANNEL_ID;
let channelId = envChannelId || config.NOTIFICATION_CHANNEL_ID || "";
const channelIsPlaceholder = !channelId || channelId.includes("REPLACE_WITH");

/* ── Step 2: Create notification channel (if needed) ── */
if (!ONLY_ALERT && channelIsPlaceholder) {
  console.log(`\n📡  Creating notification channel → ${ALERT_EMAIL}`);
  try {
    const result = execSync(
      `gcloud alpha monitoring channels create \
        --display-name="SOKONI Ops Alerts" \
        --type=email \
        --channel-labels=email_address=${ALERT_EMAIL} \
        --project=${PROJECT} \
        --format=json`,
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(result);
    channelId    = parsed.name;
    console.log(`${GRN}✔${RST}  Channel created: ${channelId}`);

    /* Persist the channel ID back into alerts.json */
    config.NOTIFICATION_CHANNEL_ID = channelId;
    fs.writeFileSync(ALERTS_PATH, JSON.stringify(config, null, 2), "utf8");
    console.log(`${GRN}✔${RST}  Saved channel ID to monitoring/alerts.json`);
  } catch (e) {
    console.error(`${RED}❌  Failed to create channel: ${e.message}${RST}`);
    console.error(`    Try running manually:`);
    console.error(`    gcloud alpha monitoring channels create --display-name="SOKONI Ops Alerts" --type=email --channel-labels=email_address=${ALERT_EMAIL}`);
    if (ONLY_CHAN) process.exit(1);
    /* Continue to alert creation with a warning */
    console.warn(`${YLW}⚠${RST}  Continuing without channel ID — alerts will be created without notifications`);
  }
} else if (!channelIsPlaceholder) {
  console.log(`${GRN}✔${RST}  Using existing channel: ${channelId}`);
}

if (ONLY_CHAN) {
  console.log(`\n${GRN}✅  Channel setup complete.${RST}\n`);
  process.exit(0);
}

/* ── Step 3: Uptime check setup ── */
if (!ONLY_ALERT) {
  console.log(`\n🩺  Creating uptime check for systemHealthCheck endpoint`);
  const healthUrl = `https://us-central1-${PROJECT}.cloudfunctions.net/systemHealthCheck`;
  try {
    execSync(
      `gcloud monitoring uptime create \
        --display-name="SOKONI System Health" \
        --resource-type=uptime-url \
        --resource-labels=host=${PROJECT}.cloudfunctions.net,path=/systemHealthCheck \
        --http-check-path=/systemHealthCheck \
        --request-method=GET \
        --check-interval=60s \
        --timeout=10s \
        --regions=usa-virginia,europe-london,asia-singapore \
        --project=${PROJECT} 2>/dev/null`,
      { encoding: "utf8" }
    );
    console.log(`${GRN}✔${RST}  Uptime check created (60s interval, 3 regions)`);
  } catch (_) {
    console.log(`${YLW}⚠${RST}  Uptime check creation skipped (may already exist)`);
  }
}

/* ── Step 4: Apply alert policies ── */
console.log(`\n🚨  Applying alert policies (${config.policies.length} policies)...`);

const { execSync: _exec } = require("child_process");
const os   = require("os");

let created = 0;
let failed  = 0;

for (const policy of config.policies) {
  const fullPolicy = {
    ...policy,
    notificationChannels: channelIsPlaceholder ? [] : [channelId],
  };

  const tmpFile = path.join(os.tmpdir(), `sokoni-alert-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(fullPolicy, null, 2), "utf8");

  const r = spawnSync(
    "gcloud",
    ["alpha", "monitoring", "policies", "create",
      `--policy-from-file=${tmpFile}`, "--quiet", `--project=${PROJECT}`],
    { encoding: "utf8" }
  );
  fs.unlinkSync(tmpFile);

  if (r.status === 0) {
    console.log(`  ${GRN}✔${RST}  ${policy.displayName}`);
    created++;
  } else {
    const err = (r.stderr || "").includes("already exists") ? "already exists" : r.stderr?.slice(0, 80);
    console.log(`  ${YLW}⚠${RST}  ${policy.displayName} ${DIM}(${err})${RST}`);
    if (!(r.stderr || "").includes("already exists")) failed++;
  }
}

/* ── Summary ── */
console.log(`\n${DIM}──────────────────────────────────────────────${RST}`);
console.log(`  ${GRN}${created} created${RST}  ${failed > 0 ? RED : ""}${failed} failed${RST}`);
console.log(`${DIM}──────────────────────────────────────────────${RST}`);
console.log(`\n  Dashboard: https://console.cloud.google.com/monitoring/alerting?project=${PROJECT}`);
console.log(`  Uptime:    https://console.cloud.google.com/monitoring/uptime?project=${PROJECT}\n`);

process.exit(failed > 0 ? 1 : 0);
