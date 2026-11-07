#!/bin/bash
# Assemble the Roam paste-in file and copy the shared core into the Logseq plugin.
set -euo pipefail
cd "$(dirname "$0")"
../llm-contact/build.sh >/dev/null # shared preamble + contact_eli tool, regenerated from ../../shared
{
  echo "// Claude in Roam — built from llm-contact/llm-contact.js + claude-chat/core.js + claude-chat/roam-adapter.js ($(date +%Y-%m-%d)). Edit those, then run claude-chat/build.sh."
  cat ../llm-contact/llm-contact.js
  echo
  cat core.js
  echo
  cat roam-adapter.js
} > ../roam/claude-in-roam.js
cp core.js ../logseq-plugins/claude-in-logseq/core.js
cp ../llm-contact/llm-contact.js ../logseq-plugins/claude-in-logseq/llm-contact.js
cp ../logseq-plugins/random-page/lsplugin.user.min.js ../logseq-plugins/claude-in-logseq/lsplugin.user.min.js
node -e "new Function(require('fs').readFileSync('../roam/claude-in-roam.js','utf8'))"
if grep -q '\x60\x60\x60' ../roam/claude-in-roam.js; then echo "ERROR: roam/claude-in-roam.js contains three backticks; Roam would cut the code block there" >&2; exit 1; fi
node -e "new Function(require('fs').readFileSync('../logseq-plugins/claude-in-logseq/index.js','utf8'))"
node test_core.js >/dev/null
echo "built roam/claude-in-roam.js and logseq-plugins/claude-in-logseq/{core,llm-contact}.js (tests pass)"
