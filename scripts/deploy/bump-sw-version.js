#!/usr/bin/env node
/**
 * SOKONI — Service Worker Version Bumper
 * Replaces the CACHE_VERSION string in service-worker.js with a date-based
 * build identifier: "sokoni-YYYYMMDDHHMMSS"
 *
 * Run from CI before the hosting deploy step:
 *   node scripts/deploy/bump-sw-version.js
 */

const fs   = require("fs");
const path = require("path");

const SW_FILE = path.resolve(__dirname, "../../service-worker.js");

if (!fs.existsSync(SW_FILE)) {
  console.error(`❌ service-worker.js not found at: ${SW_FILE}`);
  process.exit(1);
}

const now    = new Date();
const pad    = n => String(n).padStart(2, "0");
const stamp  = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
               `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
const newVer = `sokoni-${stamp}`;

const content    = fs.readFileSync(SW_FILE, "utf8");
const versionRe  = /const CACHE_VERSION\s*=\s*["']sokoni-[^"']+["']/;
const match      = content.match(versionRe);

if (!match) {
  console.error("❌ Could not find CACHE_VERSION declaration in service-worker.js");
  process.exit(1);
}

const oldVer    = match[0].match(/["']([^"']+)["']/)[1];
const updated   = content.replace(versionRe, `const CACHE_VERSION = "${newVer}"`);

fs.writeFileSync(SW_FILE, updated, "utf8");
console.log(`✅ SW version bumped: ${oldVer} → ${newVer}`);
