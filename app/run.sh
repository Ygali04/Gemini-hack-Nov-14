#!/bin/sh
# Build the overlay, start it on a FIFO, then run the agent once per prompt line.
set -e
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a
[ overlay/overlay -nt overlay/Overlay.swift ] || swiftc -O overlay/Overlay.swift -o overlay/overlay
FIFO="${CA_FIFO:-${TMPDIR:-/tmp}/computeranything.fifo}"
export CA_FIFO="$FIFO"
rm -f "$FIFO" && mkfifo "$FIFO"
# Keep the FIFO open so the overlay never sees EOF between agent runs.
(tail -f /dev/null > "$FIFO") & HOLD=$!
./overlay/overlay < "$FIFO" & OV=$!
trap 'kill $OV $HOLD 2>/dev/null; rm -f "$FIFO"' EXIT INT TERM
echo "ComputerAnything ready. Type a request (Ctrl-D to quit)."
while printf '> ' && read -r line; do
  [ -n "$line" ] && python3 agent.py "$line" || true
done
