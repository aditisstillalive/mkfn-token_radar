#!/bin/sh
# Build out/ twice from the snapshot, check both runs match byte for byte, then run the local gate.
#   tools/build.sh <snapshot.json>
set -e
SNAP=${1:-/input/snapshot.json}
rm -rf out out2 && mkdir -p out out2
MAKEFUN_OUTPUT_DIR=out node main.ts --input "$SNAP"
MAKEFUN_OUTPUT_DIR=out2 node main.ts --input "$SNAP" >/dev/null
diff -r out out2 >/dev/null && echo "determinism: both runs wrote the same bytes" || { echo "determinism: runs differ"; exit 1; }
rm -rf out2
node tools/gate.ts out "$SNAP"
