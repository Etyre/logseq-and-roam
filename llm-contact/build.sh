#!/bin/bash
# Generate llm-contact.js from the shared LLM-inbox files, so the browser-side code
# (Roam roam/js blocks, Logseq plugin iframes: no filesystem, no python) carries the
# preamble and the contact_eli tool word for word. Idempotent; re-run whenever
# ~/Documents/agent-coding/shared/llm-system-prompt-preamble.md or
# contact_eli_tool.json changes (auto-anki/build.sh and claude-chat/build.sh call it).
set -euo pipefail
cd "$(dirname "$0")"
SHARED="$HOME/Documents/agent-coding/shared"
PREAMBLE="$SHARED/llm-system-prompt-preamble.md"
TOOL="$SHARED/contact_eli_tool.json"
[ -f "$PREAMBLE" ] || { echo "missing $PREAMBLE" >&2; exit 1; }
[ -f "$TOOL" ] || { echo "missing $TOOL" >&2; exit 1; }
node - "$PREAMBLE" "$TOOL" > llm-contact.js <<'EOF'
const fs = require("fs");
const [preamblePath, toolPath] = process.argv.slice(2);
const preamble = fs.readFileSync(preamblePath, "utf8").trim();
const tool = JSON.parse(fs.readFileSync(toolPath, "utf8"));
if (/```/.test(preamble) || /```/.test(JSON.stringify(tool))) throw new Error("three backticks would end a roam/js code block");
process.stdout.write(fs.readFileSync("template.js", "utf8")
  .replace("__PREAMBLE__", JSON.stringify(preamble))
  .replace("__CONTACT_TOOL__", JSON.stringify(tool, null, 2).split("\n").join("\n  "))
  .replace("__DATE__", new Date().toISOString().slice(0, 10)));
EOF
node -e "require('./llm-contact.js'); const c = globalThis.LlmContact; if (!c.PREAMBLE.startsWith('This note is from Eli')) throw new Error('bad preamble');"
echo "built llm-contact/llm-contact.js"
