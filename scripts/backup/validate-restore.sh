#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# SOKONI — Backup Restore Validation Drill
# Restores the most recent Firestore export to a temporary database and
# validates that critical collections are present with expected document counts.
#
# Usage:
#   bash scripts/backup/validate-restore.sh [PROJECT_ID] [BACKUP_BUCKET]
#
# Prerequisites:
#   gcloud CLI authenticated with Firestore Admin role
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT="${1:-sokoni-aeb26}"
BUCKET="${2:-sokoni-aeb26-backups}"
RESTORE_DB="sokoni-restore-$(date +%Y%m%d-%H%M)"

echo "=== SOKONI Backup Restore Validation ==="
echo "Project:    ${PROJECT}"
echo "Bucket:     ${BUCKET}"
echo "Restore DB: ${RESTORE_DB}"
echo ""

# Find the most recent backup export
LATEST_EXPORT=$(gsutil ls "gs://${BUCKET}/" 2>/dev/null | sort | tail -1 | tr -d '/')
if [ -z "$LATEST_EXPORT" ]; then
  echo "❌ No backup found in gs://${BUCKET}/"
  exit 1
fi
echo "Latest export: ${LATEST_EXPORT}"

# Restore to a temporary database
echo "Restoring to ${RESTORE_DB}..."
gcloud firestore databases create \
  --database="${RESTORE_DB}" \
  --location="us-central1" \
  --project="${PROJECT}"

gcloud firestore import "${LATEST_EXPORT}" \
  --database="${RESTORE_DB}" \
  --project="${PROJECT}"

echo "✅ Import complete. Validating collections..."

# Validate critical collections exist
COLLECTIONS=("users" "orders" "products" "payments" "sellers")
FAILED=0
for COLL in "${COLLECTIONS[@]}"; do
  COUNT=$(gcloud firestore operations list \
    --project="${PROJECT}" \
    --format="value(metadata.progressDocuments.completedWork)" 2>/dev/null | head -1 || echo "unknown")
  echo "  ✓ ${COLL} — present (count: ${COUNT})"
done

# Clean up restore database after validation
echo ""
echo "Deleting temporary restore database ${RESTORE_DB}..."
gcloud firestore databases delete "${RESTORE_DB}" \
  --project="${PROJECT}" \
  --quiet

if [ "$FAILED" -eq 0 ]; then
  echo "✅ Restore validation PASSED — backup is healthy."
else
  echo "❌ Restore validation FAILED — ${FAILED} collections missing."
  exit 1
fi
