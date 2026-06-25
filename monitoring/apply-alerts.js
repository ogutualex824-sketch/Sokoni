#!/usr/bin/env node
/**
 * SOKONI Monitoring — Apply Cloud Monitoring alert policies (idempotent upsert)
 *
 * Strategy: list existing policies by displayName, update in place if found,
 * create new if not found. Fails with exit 1 if any policy write fails.
 *
 * Usage:
 *   node monitoring/apply-alerts.js
 *
 * Required env:
 *   NOTIFICATION_CHANNEL_ID  — full GCP channel resource name
 *
 * Prerequisites:
 *   gcloud auth application-default login
 *   gcloud config set project sokoni-aeb26
 */

"use strict";

const { execSync, spawnSync } = require("child_process");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

/* ── Validate environment ── */
const channelId = process.env.NOTIFICATION_CHANNEL_ID;
if (!channelId || !channelId.trim()) {
  console.error("\n❌  NOTIFICATION_CHANNEL_ID is not set.");
  console.error("   CI: add GCP_MONITORING_CHANNEL_ID as a GitHub Actions secret.");
  console.error("   Local: export NOTIFICATION_CHANNEL_ID=projects/sokoni-aeb26/notificationChannels/<ID>\n");
  process.exit(1);
}

/* ── Validate gcloud is available ── */
const gcloudCheck = spawnSync("gcloud", ["version"], { encoding: "utf8" });
if (gcloudCheck.status !== 0) {
  console.error("❌  gcloud CLI not found. Install from https://cloud.google.com/sdk/docs/install");
  process.exit(1);
}

/* ── Validate project is set ── */
const projectCheck = spawnSync("gcloud", ["config", "get-value", "project"], { encoding: "utf8" });
const activeProject = (projectCheck.stdout || "").trim();
if (!activeProject || activeProject === "(unset)") {
  console.error("❌  No active gcloud project. Run: gcloud config set project sokoni-aeb26");
  process.exit(1);
}
console.log(`Active project: ${activeProject}\n`);

/* ── Load config ── */
const CONFIG_PATH = path.join(__dirname, "alerts.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

if (!Array.isArray(config.policies) || config.policies.length === 0) {
  console.error("❌  No policies found in alerts.json");
  process.exit(1);
}

/* ── List existing policies ── */
let existingPolicies = {};
try {
  const listResult = spawnSync(
    "gcloud", ["alpha", "monitoring", "policies", "list",
      "--format=json", "--quiet"],
    { encoding: "utf8" }
  );
  if (listResult.status === 0 && listResult.stdout) {
    const existing = JSON.parse(listResult.stdout || "[]");
    for (const p of existing) {
      if (p.displayName) existingPolicies[p.displayName] = p.name;
    }
    console.log(`Found ${Object.keys(existingPolicies).length} existing alert policies.\n`);
  }
} catch (err) {
  console.warn("⚠️  Could not list existing policies — will attempt creates only:", err.message);
}

/* ── Upsert each policy ── */
let created = 0;
let updated = 0;
let failed  = 0;

for (const policy of config.policies) {
  const fullPolicy = {
    ...policy,
    notificationChannels: [channelId],
  };

  const tmpFile = path.join(os.tmpdir(), `sokoni-alert-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(fullPolicy, null, 2), "utf8");

  try {
    const existingName = existingPolicies[policy.displayName];

    if (existingName) {
      /* Update existing policy */
      const result = spawnSync(
        "gcloud", ["alpha", "monitoring", "policies", "update", existingName,
          `--policy-from-file=${tmpFile}`, "--quiet"],
        { stdio: "pipe", encoding: "utf8" }
      );
      if (result.status !== 0) {
        console.error(`❌  Update failed: ${policy.displayName}`);
        if (result.stderr) console.error("   ", result.stderr.trim().slice(0, 300));
        failed++;
      } else {
        console.log(`🔄  Updated:  ${policy.displayName}`);
        updated++;
      }
    } else {
      /* Create new policy */
      const result = spawnSync(
        "gcloud", ["alpha", "monitoring", "policies", "create",
          `--policy-from-file=${tmpFile}`, "--quiet"],
        { stdio: "pipe", encoding: "utf8" }
      );
      if (result.status !== 0) {
        console.error(`❌  Create failed: ${policy.displayName}`);
        if (result.stderr) console.error("   ", result.stderr.trim().slice(0, 300));
        failed++;
      } else {
        console.log(`✅  Created:  ${policy.displayName}`);
        created++;
      }
    }
  } catch (err) {
    console.error(`❌  Exception on: ${policy.displayName} — ${err.message}`);
    failed++;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

/* ── Summary ── */
console.log(`\n${"─".repeat(60)}`);
console.log(`Done — ${created} created, ${updated} updated, ${failed} failed.`);
if (failed > 0) {
  console.error(`\n❌  ${failed} alert policy/policies failed to apply. Deployment cannot proceed.`);
  process.exit(1);
}
console.log("✅  All alert policies applied successfully.");
