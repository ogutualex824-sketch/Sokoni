#!/usr/bin/env node
/**
 * SOKONI Monitoring — Apply Cloud Monitoring alert policies
 *
 * Usage:
 *   node monitoring/apply-alerts.js
 *
 * Prerequisites:
 *   1. gcloud CLI authenticated: gcloud auth application-default login
 *   2. Project set: gcloud config set project sokoni-aeb26
 *   3. Update NOTIFICATION_CHANNEL_ID in alerts.json with your channel ID.
 *      Create a channel:
 *        gcloud alpha monitoring channels create \
 *          --display-name="SOKONI Ops" \
 *          --type=email \
 *          --channel-labels=email_address=devops@mysokoni.co.ke
 */

"use strict";

const { execSync } = require("child_process");
const fs    = require("fs");
const path  = require("path");
const os    = require("os");

const CONFIG_PATH = path.join(__dirname, "alerts.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

// CI injects channel ID via NOTIFICATION_CHANNEL_ID env var; local uses alerts.json value
const channelId = process.env.NOTIFICATION_CHANNEL_ID || config.NOTIFICATION_CHANNEL_ID;

if (!channelId || channelId.includes("REPLACE_WITH")) {
  console.error("\n❌  NOTIFICATION_CHANNEL_ID not set.");
  console.error("   Set it in alerts.json OR export NOTIFICATION_CHANNEL_ID=<channel-id>");
  console.error("   Create a channel:");
  console.error("   gcloud alpha monitoring channels create \\");
  console.error("     --display-name=\"SOKONI Ops\" \\");
  console.error("     --type=email \\");
  console.error("     --channel-labels=email_address=devops@mysokoni.co.ke\n");
  process.exit(1);
}

let created = 0;
let failed  = 0;

for (const policy of config.policies) {
  const fullPolicy = {
    ...policy,
    notificationChannels: [channelId],
  };

  const tmpFile = path.join(os.tmpdir(), `sokoni-alert-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(fullPolicy, null, 2), "utf8");

  try {
    execSync(
      `gcloud alpha monitoring policies create --policy-from-file="${tmpFile}" --quiet`,
      { stdio: "inherit" }
    );
    console.log(`✅  Created: ${policy.displayName}`);
    created++;
  } catch (err) {
    console.error(`❌  Failed:  ${policy.displayName}`);
    failed++;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

console.log(`\nDone — ${created} created, ${failed} failed.`);
if (failed > 0) process.exit(1);
