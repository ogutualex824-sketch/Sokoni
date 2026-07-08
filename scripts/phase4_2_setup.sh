#!/usr/bin/env bash
# ==============================================================================
# Phase 4.2 — Multi-region / codebase-split SETUP (P0-4)
# Run these ONE AT A TIME, reading each comment. This script sets up the
# prerequisites and the SAFEST first migration (schedulers → europe-west1).
# It does NOT blindly restructure prod — the code split is rehearsed on staging.
#
# Prereqs: gcloud + firebase CLI authenticated; billing account id handy.
# Reference: docs/PHASE_4.2_CODEBASE_SPLIT_RUNBOOK.md
# ==============================================================================
set -euo pipefail

PROD=sokoni-aeb26
STAGING=sokoni-staging
BILLING="XXXXXX-XXXXXX-XXXXXX"   # <-- put your billing account id here
REGION2=europe-west1

# ------------------------------------------------------------------------------
# STEP 1 — Create an ISOLATED staging project (removes the #1 DevOps risk: today
# functions/rules deploy straight to prod with no pre-prod). One-time.
# ------------------------------------------------------------------------------
gcloud projects create "$STAGING" --name="SOKONI Staging"
gcloud billing projects link "$STAGING" --billing-account="$BILLING"
gcloud services enable \
  run.googleapis.com cloudfunctions.googleapis.com cloudbuild.googleapis.com \
  firestore.googleapis.com firebaseappcheck.googleapis.com \
  vpcaccess.googleapis.com secretmanager.googleapis.com \
  --project "$STAGING"
# Add the Firebase management layer
# (or: firebase projects:addfirebase "$STAGING")

# Point a Firebase target at it (edit .firebaserc):
#   { "projects": { "default": "sokoni-aeb26", "staging": "sokoni-staging" } }

# ------------------------------------------------------------------------------
# STEP 2 — (ALREADY DONE for prod) Serverless VPC connector, so Redis is reachable.
# Repeat on staging if you want Redis there too.
# ------------------------------------------------------------------------------
# gcloud compute networks vpc-access connectors create sokoni-redis-connector \
#   --network default --region us-central1 --range 10.8.0.0/28 --project "$PROD"

# ------------------------------------------------------------------------------
# STEP 3 — Request quota increases (console is easier; see QUOTA_INCREASE_REQUEST.md).
# CLI alternative (per region):
# ------------------------------------------------------------------------------
# gcloud alpha services quota update --service=run.googleapis.com \
#   --consumer=projects/$PROD --metric=... --value=2400 --unit=... --region=us-central1
# (Cloud Run CPU quota metrics vary; the console form is the reliable path.)

# ------------------------------------------------------------------------------
# STEP 4 — REHEARSE the codebase split on STAGING (never prod first).
# Follow docs/PHASE_4.2_CODEBASE_SPLIT_RUNBOOK.md §1–§3:
#   - convert firebase.json "functions" object -> array of codebases
#   - create functions-<domain>/index.js shims (setGlobalOptions region per codebase)
#   - deploy each codebase to STAGING and smoke-test
# ------------------------------------------------------------------------------
# firebase deploy --only functions:triggers --project "$STAGING"
# firebase deploy --only functions:admin    --project "$STAGING"
# ... verify schedulers fire, triggers don't double-fire, no region conflicts ...

# ------------------------------------------------------------------------------
# STEP 5 — PROD cutover, latency-tolerant codebases FIRST (frees us-central1):
# ------------------------------------------------------------------------------
# firebase deploy --only functions:triggers --project "$PROD"   # -> europe-west1
# firebase deploy --only functions:admin    --project "$PROD"   # -> europe-west1
# # confirm health, then continue codebase-by-codebase (search, pos, core, payments, ...)
# # Firebase will prompt to delete the old us-central1 copies — confirm per codebase
# # ONLY after the europe-west1 copies are verified healthy.

echo "Phase 4.2 setup steps printed. Run them one at a time, rehearsing on staging first."
