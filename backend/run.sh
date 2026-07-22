#!/usr/bin/env bash
# Runs `node index.js` continuously, restarting immediately if it ever exits or
# crashes. Stop the loop with Ctrl-C.

cd "$(dirname "$0")"

while true; do
  node index.js
  echo "[run.sh] index.js exited. Restarting..."
  sleep 2
done
