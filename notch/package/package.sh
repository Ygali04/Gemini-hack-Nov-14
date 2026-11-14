#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

bash notch/build.sh

APP_DIR="notch/build/AgentNotch.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"

rm -rf "${APP_DIR}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}/ui"

cp notch/build/AgentNotch "${MACOS_DIR}/AgentNotch"
chmod +x "${MACOS_DIR}/AgentNotch"

cat > "${CONTENTS_DIR}/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleDisplayName</key>
    <string>AgentNotch</string>
    <key>CFBundleExecutable</key>
    <string>AgentNotch</string>
    <key>CFBundleIdentifier</key>
    <string>com.agentnotch.AgentNotch</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>AgentNotch</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSMicrophoneUsageDescription</key>
    <string>Agent Workspace uses your microphone to transcribe voice prompts on this Mac when you click the mic button.</string>
    <key>NSSpeechRecognitionUsageDescription</key>
    <string>Agent Workspace transcribes your speech on this Mac to fill the prompt box.</string>
</dict>
</plist>
EOF

rsync -a --exclude='tests' --exclude='.DS_Store' ui/ "${RESOURCES_DIR}/ui/"

codesign --force --deep -s - "${APP_DIR}"

echo "Packaged ${APP_DIR}"
