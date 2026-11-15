#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${1:-${SCRIPT_DIR}/out}"

if [[ -z "${OUT_DIR}" || "${OUT_DIR}" == "/" ]]; then
  echo "Refusing unsafe output directory: '${OUT_DIR}'" >&2
  exit 1
fi

rm -rf "${OUT_DIR}"
mkdir -p \
  "${OUT_DIR}/workspace" \
  "${OUT_DIR}/shared" \
  "${OUT_DIR}/vendor/sea-glass" \
  "${OUT_DIR}/fixtures"

# Copy static pages and assets (excluding tests, deploy files, dotfiles, backend, notch)
cp "${UI_DIR}/index.html" "${OUT_DIR}/notch.html"
cp "${UI_DIR}/workspace.html" "${OUT_DIR}/workspace.html"
cp "${UI_DIR}/workspace/app.js" "${OUT_DIR}/workspace/app.js"
cp "${UI_DIR}/workspace/styles.css" "${OUT_DIR}/workspace/styles.css"
cp "${UI_DIR}/shared/agent-glass.js" "${OUT_DIR}/shared/agent-glass.js"
cp "${UI_DIR}/vendor/sea-glass/LICENSE" "${OUT_DIR}/vendor/sea-glass/LICENSE"
cp "${UI_DIR}/vendor/sea-glass/sea-glass.classic.js" "${OUT_DIR}/vendor/sea-glass/sea-glass.classic.js"

# Build top-level index.html from ui/demo/index.html with relative links for bundle root,
# and copy only the sample JSON files referenced by the demo.
node - "${UI_DIR}" "${OUT_DIR}" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const [uiDir, outDir] = process.argv.slice(2);
const demoSrcPath = path.join(uiDir, "demo", "index.html");
const demoHtml = fs.readFileSync(demoSrcPath, "utf8");

const rewritten = demoHtml
  .replace(/\.\.\/index\.html\b/g, "./notch.html")
  .replace(/\.\.\/workspace\.html\b/g, "./workspace.html");

fs.writeFileSync(path.join(outDir, "index.html"), rewritten, "utf8");

const fixtures = new Set();
for (const m of demoHtml.matchAll(/fixture=([A-Za-z0-9_-]+)/g)) fixtures.add(m[1]);
for (const m of demoHtml.matchAll(/data-(?:pill-)?sample="([^"]+)"/g)) fixtures.add(m[1]);
for (const m of demoHtml.matchAll(/(?:fixture|pillFixture):\s*"([^"]+)"/g)) fixtures.add(m[1]);
for (const m of demoHtml.matchAll(/select(?:Notch|Pill)Sample\("([^"]+)"/g)) fixtures.add(m[1]);

if (fixtures.size === 0) {
  console.error("No sample fixtures discovered in ui/demo/index.html");
  process.exit(1);
}

for (const name of [...fixtures].sort()) {
  const srcFile = path.join(uiDir, "fixtures", `${name}.json`);
  if (!fs.existsSync(srcFile)) {
    console.error(`Missing referenced sample fixture: ${srcFile}`);
    process.exit(1);
  }
  fs.copyFileSync(srcFile, path.join(outDir, "fixtures", `${name}.json`));
}
EOF

FILE_COUNT="$(find "${OUT_DIR}" -type f | wc -l | tr -d ' ')"
TOTAL_SIZE="$(du -sh "${OUT_DIR}" | awk '{print $1}')"
echo "Built static bundle at ${OUT_DIR} (${FILE_COUNT} files, ${TOTAL_SIZE})"
