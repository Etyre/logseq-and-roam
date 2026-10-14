#!/bin/bash
# Assemble the Roam paste-in file and copy the shared core into the Logseq plugin.
set -euo pipefail
cd "$(dirname "$0")"
{
  echo "// Claude in Roam — built from claude-chat/core.js + claude-chat/roam-adapter.js ($(date +%Y-%m-%d)). Edit those, then run claude-chat/build.sh."
  cat core.js
  echo
  cat roam-adapter.js
} > ../roam/claude-in-roam.js
cp core.js ../logseq-plugins/claude-in-logseq/core.js
cp ../logseq-plugins/random-page/lsplugin.user.min.js ../logseq-plugins/claude-in-logseq/lsplugin.user.min.js
node -e "new Function(require('fs').readFileSync('../roam/claude-in-roam.js','utf8'))"
if grep -q '\x60\x60\x60' ../roam/claude-in-roam.js; then echo "ERROR: roam/claude-in-roam.js contains three backticks; Roam would cut the code block there" >&2; exit 1; fi
node -e "new Function(require('fs').readFileSync('../logseq-plugins/claude-in-logseq/index.js','utf8'))"
echo "built roam/claude-in-roam.js and logseq-plugins/claude-in-logseq/core.js"
