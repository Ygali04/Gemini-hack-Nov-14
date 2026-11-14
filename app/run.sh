#!/bin/sh
# Build the overlay, start it on a FIFO, then run the agent once per prompt line.
set -e
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a
[ overlay/overlay -nt overlay/Overlay.swift ] || swiftc -O overlay/Overlay.swift -o overlay/overlay
# Private 0700 dir + 0600 FIFO: the overlay can click, so nobody else may write to it.
FDIR=$(mktemp -d) || exit 1
FIFO="$FDIR/overlay.fifo"
mkfifo -m 600 "$FIFO" || exit 1
export CA_FIFO="$FIFO"
# Keep the FIFO open so the overlay never sees EOF between agent runs.
(tail -f /dev/null > "$FIFO") & HOLD=$!
./overlay/overlay < "$FIFO" & OV=$!
trap 'kill $OV $HOLD 2>/dev/null; rm -rf "$FDIR"' EXIT INT TERM
echo "ComputerAnything ready. Type a request (Ctrl-D to quit)."
while printf '> ' && read -r line; do
  [ -n "$line" ] && python3 agent.py "$line" || true
done
