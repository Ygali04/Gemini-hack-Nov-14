#!/usr/bin/env bash
set -euo pipefail

mkdir -p notch/build
swiftc -O notch/NotchApp.swift -o notch/build/AgentNotch -framework Cocoa -framework WebKit -framework Speech -framework AVFoundation

echo "Built notch/build/AgentNotch"
echo "Start the notch app with:"
echo "  ./notch/build/AgentNotch"
echo "Or connect directly to a running backend:"
echo '  CA_URL="http://127.0.0.1:8765/?t=TOKEN" ./notch/build/AgentNotch'
