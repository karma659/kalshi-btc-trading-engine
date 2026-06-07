#!/usr/bin/env bash
# Runs `node index.js` and, after it exits at XX:59 ET, sleeps until the next
# XX:05 ET before relaunching. Stop the loop with Ctrl-C.

cd "$(dirname "$0")"

while true; do
  node index.js

  # Compute seconds until the next XX:05 ET (handles EDT/EST).
  now_min=$((10#$(TZ=America/New_York date +%M)))
  now_sec=$((10#$(TZ=America/New_York date +%S)))
  if [ "$now_min" -lt 5 ]; then
    wait=$(( (5 - now_min) * 60 - now_sec ))
  else
    wait=$(( (65 - now_min) * 60 - now_sec ))
  fi
  echo "[run.sh] index.js exited. Restarting in ${wait}s (next XX:05 ET)..."
  sleep "$wait"
done
