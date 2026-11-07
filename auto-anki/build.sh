#!/bin/bash
# Assemble the Roam paste-in file and copy the shared core into the Logseq plugin.
set -euo pipefail
cd "$(dirname "$0")"
../llm-contact/build.sh >/dev/null # shared preamble + contact_eli tool, regenerated from ../../shared
{
  echo "// auto-anki for Roam — built from llm-contact/llm-contact.js + auto-anki/core.js + auto-anki/roam-adapter.js ($(date +%Y-%m-%d)). Edit those, then run auto-anki/build.sh."
  cat ../llm-contact/llm-contact.js
  echo
  cat core.js
  echo
  cat roam-adapter.js
} > ../roam/auto-anki.js
cp core.js ../logseq-plugins/auto-anki/core.js
cp ../llm-contact/llm-contact.js ../logseq-plugins/auto-anki/llm-contact.js
cp ../logseq-plugins/random-page/lsplugin.user.min.js ../logseq-plugins/auto-anki/lsplugin.user.min.js
node -e "new Function(require('fs').readFileSync('../roam/auto-anki.js','utf8'))"
if grep -q '\x60\x60\x60' ../roam/auto-anki.js; then echo "ERROR: roam/auto-anki.js contains three backticks; Roam would cut the code block there" >&2; exit 1; fi
node -e "new Function(require('fs').readFileSync('../logseq-plugins/auto-anki/index.js','utf8'))"
node test_core.js >/dev/null
echo "built roam/auto-anki.js and logseq-plugins/auto-anki/{core,llm-contact}.js (tests pass)"
