#!/usr/bin/env bash
# setup-monitoring-alerts.sh
# M7: Wire Cloud Monitoring alert notification channels
# Run once per environment: bash scripts/setup-monitoring-alerts.sh
#
# Prerequisites:
#   gcloud auth login
#   gcloud config set project sokoni-aeb26

set -euo pipefail

PROJECT_ID="sokoni-aeb26"
ALERT_EMAIL="${1:-ogutualex824@gmail.com}"   # pass your email as $1 or it defaults

echo "Configuring monitoring notification channels for project: $PROJECT_ID"

# ── Create email notification channel ────────────────────────────────────────
CHANNEL_NAME=$(gcloud alpha monitoring channels create \
  --display-name="SOKONI Ops Alerts" \
  --type=email \
  --channel-labels="email_address=${ALERT_EMAIL}" \
  --project="${PROJECT_ID}" \
  --format="value(name)")

echo "Created channel: ${CHANNEL_NAME}"

# ── Wire channel into every existing alert policy ─────────────────────────────
# List all alert policy names and add the channel to each
POLICIES=$(gcloud alpha monitoring policies list \
  --project="${PROJECT_ID}" \
  --format="value(name)")

if [ -z "$POLICIES" ]; then
  echo "No alert policies found. Deploy functions first then re-run."
  exit 0
fi

while IFS= read -r POLICY; do
  echo "  Adding channel to: $POLICY"
  gcloud alpha monitoring policies update "${POLICY}" \
    --add-notification-channels="${CHANNEL_NAME}" \
    --project="${PROJECT_ID}" \
    --quiet
done <<< "$POLICIES"

echo ""
echo "Done. All $(echo "$POLICIES" | wc -l) alert policies now notify: ${ALERT_EMAIL}"
echo ""
echo "To verify:"
echo "  gcloud alpha monitoring channels list --project=${PROJECT_ID}"
echo "  gcloud alpha monitoring policies list --project=${PROJECT_ID}"
