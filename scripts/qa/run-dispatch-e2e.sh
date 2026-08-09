#!/usr/bin/env bash
# ============================================================================
# SOKONI — on-demand QA: two delivery-dispatch branches + exactly-once settlement
# scripts/qa/run-dispatch-e2e.sh
#
# Boots the cached Firestore emulator (JDK17), runs the REAL settleOrder + the
# first-claim-wins riderClaim transaction against it, tears the emulator down.
# Emulator only — never touches production. Exit 0 = all checks passed.
#
#   bash scripts/qa/run-dispatch-e2e.sh
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

JAVA="${JAVA:-/c/Program Files/Microsoft/jdk-17.0.19.10-hotspot/bin/java.exe}"
JAR="${FS_EMU_JAR:-$HOME/.cache/firebase/emulators/cloud-firestore-emulator-v1.19.8.jar}"
PORT="${FS_EMU_PORT:-8722}"
LOG="$(mktemp -t fs-emu-qa.XXXXXX.log)"

[ -x "$JAVA" ] || { echo "JDK17 not found at $JAVA (override with \$JAVA)"; exit 2; }
[ -f "$JAR" ]  || { echo "Firestore emulator JAR not found at $JAR (override with \$FS_EMU_JAR)"; exit 2; }

echo "Booting Firestore emulator 127.0.0.1:$PORT ..."
"$JAVA" -jar "$JAR" --host 127.0.0.1 --port "$PORT" >"$LOG" 2>&1 &
EMU_PID=$!
trap 'kill $EMU_PID 2>/dev/null; wait $EMU_PID 2>/dev/null; rm -f "$LOG"' EXIT

for _ in $(seq 1 40); do
  grep -qiE "API endpoint|running|listening" "$LOG" 2>/dev/null && break
  kill -0 $EMU_PID 2>/dev/null || { echo "Emulator died early:"; cat "$LOG"; exit 9; }
  sleep 1
done

FIRESTORE_EMULATOR_HOST="127.0.0.1:$PORT" node functions/qa-dispatch-settlement-e2e.js
exit $?
