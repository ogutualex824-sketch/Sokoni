#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# SOKONI — Enable Firestore Point-in-Time Recovery (PITR)
# Run once per project.  Requires Owner or Datastore Admin IAM role.
#
# Usage:
#   bash scripts/enable-pitr.sh [PROJECT_ID]
#
# Prerequisites:
#   gcloud CLI authenticated: gcloud auth login
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT="${1:-sokoni-aeb26}"

echo "Enabling PITR for project: ${PROJECT}"

gcloud firestore databases update "(default)" \
  --project="${PROJECT}" \
  --enable-point-in-time-recovery

echo "✅ PITR enabled. Retention window: 7 days (default)."
echo ""
echo "To restore to a point in time:"
echo "  gcloud firestore databases restore \\"
echo "    --source-database='(default)' \\"
echo "    --destination-database='sokoni-restore-YYYYMMDD' \\"
echo "    --snapshot-time='YYYY-MM-DDTHH:MM:SSZ' \\"
echo "    --project='${PROJECT}'"
echo ""
echo "To verify PITR is active:"
echo "  gcloud firestore databases describe '(default)' --project='${PROJECT}'"
